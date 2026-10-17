const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { mcpClient, DEFAULT_MCP_URL } = require('./mcp-client');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const port = process.env.PORT || 4000;
const compilerDir = path.join(__dirname, 'compiler-service');
const dockerImage = 'qedui-lean4-service';
let dockerImageReady;
const DEFAULT_PROVIDER = process.env.AGENT_PROVIDER_DEFAULT || 'academic-cloud';
const PROVIDER_LABELS = {
  heuristic: 'Local Heuristic',
  openai: 'OpenAI',
  'azure-openai': 'Azure OpenAI',
  ollama: 'Ollama',
  'academic-cloud': 'Meta Llama'
};

function getProviderStatus(provider) {
  if (provider === 'heuristic') {
    return { configured: true, reason: 'Local heuristic engine is always available.' };
  }

  if (provider === 'openai') {
    return { configured: Boolean(process.env.OPENAI_API_KEY), reason: process.env.OPENAI_API_KEY ? 'OpenAI API key is configured.' : 'OpenAI API key is missing.' };
  }

  if (provider === 'azure-openai') {
    const configured = Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY);
    return { configured, reason: configured ? 'Azure OpenAI is configured.' : 'Azure OpenAI credentials are missing.' };
  }

  if (provider === 'ollama') {
    const configured = Boolean(process.env.OLLAMA_BASE_URL && process.env.OLLAMA_BASE_URL.trim());
    return { configured, reason: configured ? 'Ollama endpoint is configured.' : 'Ollama endpoint is not configured.' };
  }

  if (provider === 'academic-cloud') {
    return { configured: Boolean(process.env.ACADEMIC_CLOUD_API_KEY), reason: process.env.ACADEMIC_CLOUD_API_KEY ? 'Academic Cloud API key is configured.' : 'Academic Cloud API key is missing.' };
  }

  return { configured: false, reason: 'Unknown provider.' };
}

function getConfiguredProviders() {
  const raw = (process.env.AGENT_PROVIDERS || 'heuristic,openai,azure-openai,ollama,academic-cloud').split(',').map((item) => item.trim()).filter(Boolean);
  return [...new Set(raw.filter((item) => PROVIDER_LABELS[item] || item === 'heuristic'))];
}

const AI_PROVIDERS = getConfiguredProviders();
const chatSessions = new Map();

function buildSessionContext(history = []) {
  const entries = Array.isArray(history) ? history : [];
  const cleaned = entries
    .filter(Boolean)
    .map((entry) => {
      const role = entry.role === 'assistant' ? 'assistant' : 'user';
      const text = String(entry.text ?? entry.content ?? '').trim();
      return text ? { role, text } : null;
    })
    .filter(Boolean)
    .slice(-8);

  if (!cleaned.length) {
    return '';
  }

  return `Conversation context:\n${cleaned.map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`).join('\n')}\n`;
}

function getSessionHistory(sessionId, incomingHistory = []) {
  const session = chatSessions.get(sessionId) || { messages: [] };
  const normalized = Array.isArray(incomingHistory) ? incomingHistory : [];

  if (normalized.length) {
    const historyEntries = normalized
      .filter((entry) => entry && typeof entry === 'object' && (entry.text || entry.content))
      .map((entry) => ({
        role: entry.role === 'assistant' ? 'assistant' : 'user',
        text: String(entry.text ?? entry.content ?? '').trim()
      }))
      .filter((entry) => entry.text);

    if (historyEntries.length) {
      session.messages = historyEntries.slice(-12);
      chatSessions.set(sessionId, session);
    }
  }

  return session.messages || [];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callAcademicCloudProvider({ message, code, provider, mode = 'lean', conversationContext = '' }) {
  const rawEndpoint = process.env.ACADEMIC_CLOUD_ENDPOINT || 'https://chat-ai.academiccloud.de/v1/chat/completions';
  const apiKey = process.env.ACADEMIC_CLOUD_API_KEY || '';
  const model = process.env.ACADEMIC_CLOUD_MODEL || 'meta-llama-3.1-8b-instruct';
  const chatEndpoint = rawEndpoint.includes('/v1/chat/completions')
    ? rawEndpoint
    : rawEndpoint.replace(/\/v1\/completions$/i, '') + '/v1/chat/completions';
  const completionsEndpoint = rawEndpoint.includes('/v1/completions') && !rawEndpoint.includes('/v1/chat/completions')
    ? rawEndpoint
    : rawEndpoint.replace(/\/v1\/chat\/completions$/i, '') + '/v1/completions';

  const temperature = Number(process.env.ACADEMIC_CLOUD_TEMPERATURE ?? 0.2);
  const sendTemperature = (typeof temperature === 'number' && temperature > 2)
    ? Math.min(1, temperature / 100)
    : Math.max(0, Math.min(1, Number(temperature) || 0.2));

  const promptText = buildPatchPrompt(message, code, '', conversationContext, mode);
  const systemPrompt = mode === 'chat'
    ? 'You are a thoughtful Lean 4 coding assistant embedded in an editor. Use the full current code and conversation to understand the user intent. Return only valid JSON with a concise, natural "response" and a "suggestions" array of up to three short follow-up requests the user could ask next. Suggestions must be specific to the current code and conversation, not generic Lean keywords or tactics. Do not suggest code edits unless relevant, and never include or change code in this chat response.'
    : 'You are an expert Lean 4 proof assistant. Generate strictly valid Lean 4 syntax (NEVER Lean 3 begin/end or commas between tactics). Return ONLY valid JSON with keys "response", "proofState", "suggestions", "updatedCode". The "updatedCode" property must be a valid JSON string containing the complete, valid Lean 4 code.';

  const requestBodies = [
    // Chat endpoint first (recommended for Meta Llama 3.1 instruct)
    {
      method: 'POST',
      url: chatEndpoint,
      body: JSON.stringify({
        model,
        temperature: sendTemperature,
        max_tokens: mode === 'chat' ? 600 : 1500,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: promptText }
        ]
      })
    },
    // Fallback to completions endpoint if chatEndpoint fails
    {
      method: 'POST',
      url: completionsEndpoint,
      body: JSON.stringify({
        model,
        prompt: promptText,
        temperature: sendTemperature,
        max_tokens: mode === 'chat' ? 600 : 1500
      })
    }
  ];

  let lastError = null;
  for (const request of requestBodies) {
    try {
      if (process.env.ACADEMIC_CLOUD_DEBUG) console.log('[AcademicCloud] Requesting', request.url);
      const response = await fetchWithTimeout(request.url, {
        method: request.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'qedui-backend/1.0',
          'Content-Type': 'application/json'
        },
        body: request.body
      }, 60000);

      if (!response.ok) {
        const text = await response.text();
        lastError = new Error(`Academic Cloud request failed: ${response.status} ${text}`);
        continue;
      }

      const data = await response.json();
      if (process.env.ACADEMIC_CLOUD_DEBUG) {
        try {
          console.log('[AcademicCloud] Raw response:', JSON.stringify(data));
        } catch (e) {
          console.log('[AcademicCloud] Raw response (stringify failed):', String(data));
        }
      }

      const content = data.choices?.[0]?.message?.content
        || data.choices?.[0]?.text
        || data.choices?.[0]?.output?.content?.[0]?.text
        || data.output?.text
        || data.outputs?.[0]?.content?.text
        || data.completion
        || data.text
        || data.output
        || data.generated_text
        || data.result?.content
        || '';
      const rawContent = typeof content === 'string' ? content : JSON.stringify(content || {});
      const parsed = parseToolAwareJson(rawContent);
      const codeBlock = extractCodeFence(rawContent);
      const plainTextResponse = extractPlainTextResponse(rawContent);
      const inferredCode = coerceLeanPatch(rawContent, code);
      const fallbackCode = codeBlock && /\b(import|theorem|example|lemma|def|:=|by)\b/.test(codeBlock)
        ? cleanCodeFence(codeBlock)
        : inferredCode && looksLikeLeanCode(inferredCode)
          ? cleanCodeFence(inferredCode)
          : code;

      if (parsed) {
        const normalizedUpdatedCode = typeof parsed.updatedCode === 'string'
          ? cleanCodeFence(parsed.updatedCode)
          : typeof parsed.updatedCode === 'object' && parsed.updatedCode && typeof parsed.updatedCode.code === 'string'
            ? cleanCodeFence(parsed.updatedCode.code)
            : fallbackCode;
        const nextCode = normalizeUpdatedCode(normalizedUpdatedCode, fallbackCode);
        const responseText = typeof parsed.response === 'string'
          ? parsed.response
          : typeof parsed.message === 'string'
            ? parsed.message
            : plainTextResponse;
        return {
          ok: true,
          response: responseText,
          suggestions: normalizeStructuredSuggestions(parsed.suggestions, mode === 'chat' ? [] : ['intro h', 'simp', 'exact rfl']),
          proofState: normalizeStructuredProofState(parsed.proofState, 'Goal: refine the Lean proof using the direct strategy that matches the theorem.'),
          streamText: responseText,
          updatedCode: nextCode,
          provider
        };
      }

      if (looksLikeLeanCode(rawContent) || looksLikeLeanCode(fallbackCode)) {
        return {
          ok: true,
          response: plainTextResponse || 'I found a Lean patch and kept the relevant proof structure.',
          suggestions: mode === 'chat' ? [] : ['intro h', 'simp', 'exact rfl'],
          proofState: 'Goal: refine the Lean proof using the direct strategy that matches the theorem.',
          streamText: plainTextResponse || 'I found a Lean patch and kept the relevant proof structure.',
          updatedCode: fallbackCode,
          provider
        };
      }

      return {
        ok: true,
        response: plainTextResponse,
        suggestions: mode === 'chat' ? [] : ['intro h', 'simp', 'exact rfl'],
        proofState: 'Goal: refine the Lean proof using the most direct valid tactic.',
        streamText: plainTextResponse,
        updatedCode: fallbackCode,
        provider
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Academic Cloud request returned no usable response.');
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function decideAgentAction(message = '', code = '') {
  const text = (message || '').toLowerCase().trim();

  // Pure conversational / greeting — no Lean knowledge needed
  const isGreeting = /^(hi|hello|hey|howdy|yo|sup|greetings|good\s*(morning|afternoon|evening)|what('s| is) up|hiya|helo|hii+|helo+)[\s!?.]*$/.test(text);
  if (isGreeting) return 'chat';

  // General questions about the tool / capabilities
  const isMetaQuestion = /(what can you do|how do you work|what are you|who are you|tell me about yourself|your (features|capabilities|tools)|help me understand|what is this|what does this (app|editor|tool) do)/i.test(text);
  if (isMetaQuestion) return 'chat';

  // MCP server status queries
  if (/(server status|mcp status|is lean (ready|available|running)|is mathlib (ready|available)|lake status|readiness)/i.test(text)) {
    return 'mcp_status';
  }

  // MCP runtime config queries
  if (/(runtime config|mcp config|server config)/i.test(text)) {
    return 'mcp_config';
  }

  // MCP static code analysis
  if (/(analyze (the )?(code|source|lean)|static analysis|count theorems|code stats|code statistics|tactics found)/i.test(text)) {
    return 'mcp_analyze';
  }

  // Explicit compiler trigger
  const explicitCompiler = /^(compile|run lean|check code|validate code)\b/i.test(text);
  if (explicitCompiler) return 'compiler';

  // Fast evaluation query
  if (/(evaluate (the )?(code|lean)|error count|how many errors|count sorries)/i.test(text)) {
    return 'mcp_evaluate';
  }

  // MCP automated problem solving or proof search
  if (/(automated (proof|solver)|solve problem|run solver|run dpps|search dpps|schedule pgtm|run pgtm)/i.test(text)) {
    return 'mcp_solve';
  }

  const asksForProofGuidance = /^(?:please\s+)?(?:help me|can you help me|could you help me)\s+(?:to\s+)?prove\b/i.test(text);
  if (asksForProofGuidance) return 'llm';

  // Lean code editing / generation / betterment intent
  const explicitEdit = /(formalize|rewrite|fix|better|improve|golf|simplify|update|patch|edit|replace|change|make it|complete the proof|prove|show|lemma|theorem|construct|write proof|build proof|generate proof|add tactic|insert|generate|write (lean|code|theorem|lemma|def)|create (lean|code|theorem|lemma|def)|give me (lean|code|theorem|lemma)|code for|implement|definition)/i.test(text);
  if (explicitEdit) return 'edit';

  // MCP / file tool intent
  if (/(read|search|list files|find theorem|repo|open file|inspect|locate|context|lookup)/i.test(text)) return 'mcp_tool';

  // Lean explanation / guidance
  const explicitLlm = /(explain|why|how|what is|goal|tactic|help|assist|teach|walk through|walkthrough|suggest|hint)/i.test(text);
  if (explicitLlm) return 'llm';

  return 'llm';
}

function sanitizeLeanSnippet(code = '') {
  return (code || '').replace(/\s+/g, ' ').trim();
}

function analyzeLeanState(code = '', message = '') {
  const source = (code || '').trim();
  const prompt = (message || '').toLowerCase();
  const missingThings = [];
  const improvements = [];

  if (!source) {
    missingThings.push('empty Lean source');
  }

  if (!source.includes('import')) {
    missingThings.push('missing import');
  }

  if (source.includes('example') && !source.includes(':=')) {
    missingThings.push('missing theorem signature or proof body');
  }

  if (source.includes('by') && !source.match(/:=\s*by\s*$/m)) {
    improvements.push('finish the proof body with the next tactic step');
  }

  if (source.includes('sorry')) {
    improvements.push('replace sorry with a real proof term');
  }

  if (/(formalize|prove|show|lemma|theorem)/.test(prompt)) {
    improvements.push('formalize the theorem statement and close the final goal');
  }

  if (/(simp|rewrite|algebra)/.test(prompt)) {
    improvements.push('simplify the target and apply the most direct rewrite');
  }

  if (source.includes('example') && source.includes('by') && !source.includes('simp') && !source.includes('exact')) {
    improvements.push('add a simplification or exact step to discharge the goal');
  }

  return {
    missingThings,
    improvements,
    nextActions: [
      ...(missingThings.length ? ['fix missing Lean structure'] : []),
      ...(improvements.length ? ['apply tactic improvement'] : []),
      'validate with compiler'
    ]
  };
}

function applyPatchToCode(code = '', message = '') {
  const cleaned = code || '';
  const normalized = (message || '').toLowerCase();

  if (!cleaned.trim()) {
    return cleaned;
  }

  if (normalized.includes('simp') || normalized.includes('simplify')) {
    if (!cleaned.includes('simp')) {
      return cleaned.replace(/:=\s*by\s*$/m, ':= by\n  simp');
    }
  }

  if (normalized.includes('exact') || normalized.includes('replace')) {
    if (!cleaned.includes('exact')) {
      return cleaned.replace(/:=\s*by\s*$/m, ':= by\n  exact rfl');
    }
  }

  if (normalized.includes('intro') || normalized.includes('variables')) {
    if (!cleaned.includes('intro')) {
      return cleaned.replace(/:=\s*by\s*$/m, ':= by\n  intro h');
    }
  }

  if (normalized.includes('cases')) {
    if (!cleaned.includes('cases')) {
      return cleaned.replace(/:=\s*by\s*$/m, ':= by\n  cases h');
    }
  }

  return cleaned;
}

function buildToolRegistry() {
  return {
    read_file: async ({ code = '' }) => ({
      ok: true,
      content: code,
      summary: sanitizeLeanSnippet(code).slice(0, 180) || 'No Lean code provided.'
    }),
    compile_lean: async ({ code = '' }) => compileLeanCode(code),
    evaluate_lean_code: async ({ code = '' }) => mcpClient.evaluateLeanCode(code),
    analyze_lean_code: async ({ code = '' }) => mcpClient.analyzeLeanCode(code),
    get_server_status: async () => mcpClient.getServerStatus(),
    suggest_tactics: async ({ code = '', message = '' }) => {
      const context = sanitizeLeanSnippet(code);
      const prompt = (message || '').toLowerCase();
      const suggestions = ['intro', 'simp', 'exact', 'cases', 'rw', 'omega', 'rfl'];
      const prioritized = [];

      if (prompt.includes('simp')) prioritized.push('simp');
      if (prompt.includes('exact')) prioritized.push('exact');
      if (prompt.includes('intro')) prioritized.push('intro');
      if (prompt.includes('cases')) prioritized.push('cases');
      if (prompt.includes('rw')) prioritized.push('rw');
      if (prompt.includes('omega')) prioritized.push('omega');
      if (prompt.includes('rfl')) prioritized.push('rfl');

      const result = [...new Set([...prioritized, ...suggestions])];
      return { ok: true, suggestions: result.slice(0, 5), context, message };
    },
    apply_patch: async ({ code = '', message = '' }) => {
      const updatedCode = applyPatchToCode(code, message);
      return { ok: true, updatedCode, message: 'Patch applied successfully.' };
    }
  };
}

async function runMcpToolCycle({ message = '', code = '', provider = 'heuristic' }) {
  const registry = buildToolRegistry();
  const tools = [
    { name: 'read_file', args: { code } },
    { name: 'compile_lean', args: { code } },
    { name: 'suggest_tactics', args: { code, message } }
  ];

  const toolResults = {};
  for (const tool of tools) {
    const fn = registry[tool.name];
    if (fn) {
      try {
        toolResults[tool.name] = await fn(tool.args);
      } catch (_e) {}
    }
  }

  const compileStatus = toolResults.compile_lean || { ok: true, suggestion: [] };
  const tacticSuggestions = toolResults.suggest_tactics?.suggestions || ['intro', 'simp', 'exact', 'cases', 'rw'];
  const patched = await registry.apply_patch({ code, message });
  const finalCode = patched.updatedCode || code;
  const leanState = analyzeLeanState(finalCode, message);

  const analysis = {
    ok: true,
    response: `I checked the Lean context and applied a targeted patch. The compiler status is ${compileStatus.ok ? 'clean enough to continue' : 'still needs attention'}, and the strongest next tactics are ${tacticSuggestions.join(', ')}.`,
    suggestions: tacticSuggestions,
    proofState: compileStatus.ok
      ? 'Goal: keep the proof minimal and close the final target with the simplest valid Lean tactic.'
      : (compileStatus.proofState || 'Goal: the current theorem still needs a direct fix; reduce the target and re-check the next tactic.'),
    streamText: `I checked the Lean context and applied a targeted patch. The strongest next tactics are ${tacticSuggestions.join(', ')}.`,
    provider,
    updatedCode: finalCode,
    toolsUsed: ['compile_lean_code', ...Object.keys(toolResults).filter(t => t !== 'compile_lean')],
    missingThings: leanState.missingThings,
    improvements: leanState.improvements,
    nextActions: leanState.nextActions,
    note: 'MCP tool cycle executed.'
  };

  return analysis;
}

function attachAgentInsights(payload, code = '', message = '') {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const source = (payload.updatedCode && typeof payload.updatedCode === 'string') ? payload.updatedCode : code;
  const insight = analyzeLeanState(source, message);

  return {
    ...payload,
    missingThings: payload.missingThings || insight.missingThings,
    improvements: payload.improvements || insight.improvements,
    nextActions: payload.nextActions || insight.nextActions
  };
}

function buildChatResponse(message = '', code = '', provider = 'heuristic') {
  const text = (message || '').trim().toLowerCase();
  const hasCode = (code || '').trim().length > 0;

  const isGreeting = /^(hi|hello|hey|howdy|yo|sup|hiya|helo|hii+|helo+|greetings|good\s*(morning|afternoon|evening)|what('s| is) up)[\s!?.]*$/.test(text);

  let response;

  if (isGreeting) {
    response = `👋 Hi there! I'm your **Lean 4 AI assistant** — here to help you write, debug, and understand Lean 4 proofs and code.\n\nHere's what I can do:\n- 🔧 **Fix errors** in your Lean code\n- 💡 **Suggest tactics** (simp, exact, intro, cases, rw, …)\n- 📖 **Explain** proof steps and Lean concepts\n- ✏️ **Edit / rewrite** theorems and definitions\n- 🔍 **Inspect** proof state and goals\n- ⚡ **Compile** your code and diagnose errors${hasCode ? '\n\nI can see you have Lean code in the editor — feel free to ask me anything about it!' : '\n\nTry typing some Lean code in the editor and ask me to compile, fix, or explain it!'}\n\nWhat would you like to work on?`;
  } else {
    // Meta / capability question
    response = `I'm a **Lean 4 coding assistant** integrated directly into this editor. Here's what I can help you with:\n\n**Code Actions**\n- Ask me to *fix*, *rewrite*, or *improve* any part of your Lean code\n- Say *"compile"* to run a syntax + type check on your code\n- Say *"suggest tactics"* to get relevant proof steps\n\n**Learning & Explanation**\n- Ask *"explain [tactic/concept]"* and I'll walk you through it\n- Ask *"what's the proof state?"* to understand the current goal\n\n**Tools I use**\n- 📂 \`read_file\` — reads your current editor code\n- 🔨 \`compile_lean\` — runs Lean validation\n- 🧠 \`suggest_tactics\` — recommends next proof steps\n- 🩹 \`apply_patch\` — applies targeted edits\n\nJust type naturally — I'll figure out what you need!`;
  }

  return {
    ok: true,
    response,
    agent: `LeanAssistant:${provider}`,
    suggestions: ['compile', 'suggest tactics', 'explain simp', 'fix errors'],
    proofState: hasCode ? 'Ready — ask me to compile, fix, or explain your code.' : 'No code in editor yet — paste some Lean 4 code to get started.',
    streamText: response,
    provider,
    updatedCode: null,   // never modify code on a greeting
    missingThings: [],
    improvements: [],
    nextActions: []
  };
}

function buildHeuristicResponse(message = '', code = '', provider = 'heuristic') {
  const prompt = (message || '').trim();
  const lowerPrompt = prompt.toLowerCase();
  const codePreview = (code || '').slice(0, 200);
  const hasCode = codePreview.trim().length > 0;

  const suggestions = ['intro h', 'simp', 'exact rfl', 'cases h', 'rw [Nat.add_comm]'];

  let answer;

  if (lowerPrompt.includes('proof')) {
    answer = 'The proof likely needs another step at the goal boundary. Try introducing variables with `intro`, then close with `exact` or `simp` on the final proposition.';
  } else if (lowerPrompt.includes('error') || lowerPrompt.includes('fix')) {
    answer = 'The most common Lean issue is a mismatch between the theorem type and the proof term. Compare the goal with the expression you\'re returning, simplify the target, then rewrite.';
  } else if (lowerPrompt.includes('tactic') || lowerPrompt.includes('suggest')) {
    answer = 'Useful tactics for most goals: `intro`, `cases`, `simp`, `exact`, and `omega` for arithmetic. Keep the proof focused on the current goal rather than rewriting the whole theorem.';
  } else if (lowerPrompt.includes('goal')) {
    answer = 'Current strategy: reduce the goal to a simpler proposition, then apply a tactic that exactly matches the conclusion.';
  } else if (lowerPrompt.includes('explain') || lowerPrompt.includes('how') || lowerPrompt.includes('what')) {
    answer = 'I\'m the heuristic local engine. For deeper explanations, select **Meta Llama** from the LLM dropdown — it can reason about Lean semantics in detail.';
  } else if (lowerPrompt.includes('compile') || lowerPrompt.includes('check')) {
    answer = 'Click the **Compile** button in the toolbar to run Lean validation on your code. I\'ll show errors and proof state in the panels below.';
  } else {
    answer = hasCode
      ? `I see Lean code in the editor. I can help fix errors, suggest tactics, or explain the proof. What specifically would you like me to do?`
      : 'I\'m your Lean 4 coding assistant. Paste some Lean code in the editor, then ask me to compile, fix, or explain it.';
  }

  if (hasCode && !['compile', 'check'].some(k => lowerPrompt.includes(k))) {
    answer += ` (Looking at your code: \`${codePreview.replace(/\s+/g, ' ').slice(0, 60)}…\`)`;
  }

  const response = answer;
  const leanState = analyzeLeanState(code, message);

  return {
    ok: true,
    response,
    agent: `LeanAssistant:${provider}`,
    suggestions,
    proofState: hasCode ? 'Goal: simplify the theorem and close the final target with the shortest tactic.' : 'No code yet — paste Lean 4 source to get started.',
    streamText: response,
    provider,
    updatedCode: null,   // heuristic should never silently edit code
    missingThings: leanState.missingThings,
    improvements: leanState.improvements,
    nextActions: leanState.nextActions,
    note: provider === 'heuristic' ? 'Heuristic response generated locally.' : undefined
  };
}

function cleanCodeFence(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/^```(?:lean|lean4)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function looksLikeLeanCode(rawText) {
  if (typeof rawText !== 'string') return false;

  const candidate = rawText.trim();
  if (!candidate) return false;

  const stripped = candidate.replace(/^```(?:lean|lean4)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const content = stripped || candidate;

  const leanDeclaration = /(?:^|\n)\s*(?:import|theorem|example|lemma|def|structure|inductive|class|instance|axiom|variable|open|namespace|section)\b/m.test(content);
  const proofMarker = /:=\s*by\b|:=\s*\w|\bby\b|\bwhere\b|\bsorry\b|\brfl\b/.test(content);
  const tacticMarker = /(?:^|\n)\s*(?:intro|simp|exact|rw|cases|assumption|constructor|refine|aesop|omega|have|match|let|calc)\b/m.test(content);
  const typeMarker = /:\s*(?:Nat|Int|Bool|String|Prop|Type|List|\w+\s*->\s*\w+|\w+\s*\*\s*\w+)/.test(content);

  return Boolean(leanDeclaration || ((typeMarker || tacticMarker) && (proofMarker || tacticMarker)));
}

function extractLeanCodeFromText(rawText) {
  if (typeof rawText !== 'string') return null;

  const text = rawText
    .replace(/```(?:lean|lean4)?/gi, '')
    .replace(/```/g, '')
    .trim();

  if (!text) return null;

  const declarationMatch = text.match(/(?:^|\n)\s*(?:import\s+Mathlib\s*\n|(?:theorem|example|lemma|def)[\s\S]*?)(?=\n\s*(?:theorem|example|lemma|def)|$)/i);
  if (declarationMatch && declarationMatch[0].trim()) {
    const candidate = declarationMatch[0].trim();
    if (looksLikeLeanCode(candidate)) return candidate;
  }

  const tacticLines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\s*(?:intro|simp|exact|rw|cases|assumption|constructor|refine|aesop|omega|have|match|let)\b/i.test(line));
  if (tacticLines.length) {
    return tacticLines.join('\n');
  }

  return null;
}

function coerceLeanPatch(rawText, fallbackCode = '') {
  const fenced = extractCodeFence(rawText);
  if (fenced) {
    return normalizeUpdatedCode(fenced, fallbackCode);
  }

  const extracted = extractLeanCodeFromText(rawText);
  if (extracted) {
    if (fallbackCode.includes(':= by') && !/:=\s*by/.test(extracted)) {
      const proofOnly = extracted.replace(/^\s*by\s*/i, '').trim();
      const next = fallbackCode.replace(/:=\s*by[\s\S]*$/, `:= by\n  ${proofOnly.replace(/\n/g, '\n  ')}\n`);
      return normalizeUpdatedCode(next, fallbackCode);
    }

    return normalizeUpdatedCode(extracted, fallbackCode);
  }

  return fallbackCode;
}

function extractCodeFence(rawText) {
  if (typeof rawText !== 'string') return null;

  const fenceMatch = rawText.match(/```(?:lean|lean4)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    const cleaned = fenceMatch[1].trim();
    return looksLikeLeanCode(cleaned) ? cleaned : null;
  }

  if (looksLikeLeanCode(rawText)) {
    return rawText.trim();
  }

  return null;
}

function extractPlainTextResponse(rawText) {
  if (typeof rawText !== 'string') return 'I generated a Lean suggestion for you.';

  const fenced = rawText.replace(/```(?:lean|lean4)?[\s\S]*?```/gi, '').trim();
  const compact = fenced.replace(/\s+/g, ' ').trim();

  if (!compact) {
    return 'I generated a Lean suggestion for you.';
  }

  return compact.slice(0, 500);
}

function parseToolAwareJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  let text = rawText.trim();

  // Strip outer markdown code fence if wrapped
  const jsonFence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (jsonFence) {
    text = jsonFence[1].trim();
  }

  // Attempt 1: Direct JSON.parse
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (parsed.updatedCode && typeof parsed.updatedCode === 'string') {
        parsed.updatedCode = cleanCodeFence(parsed.updatedCode);
      }
      return parsed;
    }
  } catch (_e) {}

  // Attempt 2: Extract substring between first { and last }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const jsonSub = text.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonSub);
      if (parsed && typeof parsed === 'object') {
        if (parsed.updatedCode && typeof parsed.updatedCode === 'string') {
          parsed.updatedCode = cleanCodeFence(parsed.updatedCode);
        }
        return parsed;
      }
    } catch (_e2) {
      // Replace backtick string literals like `"updatedCode": `...``
      try {
        const replacedBackticks = jsonSub.replace(/:\s*`([\s\S]*?)`/g, (_m, p1) => ': ' + JSON.stringify(p1));
        const parsed = JSON.parse(replacedBackticks);
        if (parsed && typeof parsed === 'object') {
          if (parsed.updatedCode && typeof parsed.updatedCode === 'string') {
            parsed.updatedCode = cleanCodeFence(parsed.updatedCode);
          }
          return parsed;
        }
      } catch (_e3) {}
    }
  }

  // Attempt 3: Regex-based field extraction fallback
  const result = {};

  const responseMatch = text.match(/"response"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|`([\s\S]*?)`)/i);
  if (responseMatch) {
    result.response = responseMatch[1] ? responseMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : responseMatch[2];
  }

  const proofStateMatch = text.match(/"proofState"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|`([\s\S]*?)`|({[\s\S]*?}))/i);
  if (proofStateMatch) {
    if (proofStateMatch[1]) result.proofState = proofStateMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    else if (proofStateMatch[2]) result.proofState = proofStateMatch[2];
    else if (proofStateMatch[3]) {
      try {
        result.proofState = JSON.parse(proofStateMatch[3]);
      } catch (_e) {
        result.proofState = proofStateMatch[3];
      }
    }
  }

  const updatedCodeMatch = text.match(/"updatedCode"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|`([\s\S]*?)`)/i);
  if (updatedCodeMatch) {
    const rawCode = updatedCodeMatch[1] ? updatedCodeMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : updatedCodeMatch[2];
    result.updatedCode = cleanCodeFence(rawCode);
  } else {
    const leanFence = text.match(/```(?:lean|lean4)?\s*([\s\S]*?)```/i);
    if (leanFence) {
      result.updatedCode = leanFence[1].trim();
    }
  }

  const suggestionsMatch = text.match(/"suggestions"\s*:\s*\[([\s\S]*?)\]/i);
  if (suggestionsMatch) {
    try {
      result.suggestions = JSON.parse(`[${suggestionsMatch[1]}]`);
    } catch (_e) {
      result.suggestions = suggestionsMatch[1]
        .split(',')
        .map((s) => s.replace(/["'`\[\]]/g, '').trim())
        .filter(Boolean);
    }
  }

  if (result.response || result.updatedCode || result.proofState || result.suggestions) {
    return result;
  }

  return null;
}

function normalizeStructuredSuggestions(value, fallback = ['intro h', 'simp', 'exact rfl']) {
  if (!Array.isArray(value)) return fallback;

  const normalized = value.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      if (typeof item.label === 'string') return item.label;
      if (typeof item.step === 'string') return item.step;
      if (typeof item.lemma === 'string') return item.lemma;
      if (typeof item.tactic === 'string') return item.tactic;
      if (typeof item.proof === 'string') return item.proof;
      if (typeof item.statement === 'string') return item.statement;
      if (item.action && typeof item.action === 'string') return item.action;
      return JSON.stringify(item);
    }
    return String(item);
  }).filter((item) => typeof item === 'string' && item.trim() && item !== '[object Object]');

  return normalized.length ? normalized.slice(0, 5) : fallback;
}

function normalizeStructuredProofState(value, fallback = 'Goal: refine the Lean proof using the direct strategy that matches the theorem.') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    if (typeof value.goal === 'string' && value.goal.trim()) return value.goal.trim();
    if (typeof value.message === 'string' && value.message.trim()) return value.message.trim();
    if (typeof value.summary === 'string' && value.summary.trim()) return value.summary.trim();
    if (typeof value.statement === 'string' && value.statement.trim()) return `Goal: ${value.statement.trim()}`;
    return JSON.stringify(value);
  }
  return fallback;
}

function cleanLean3Syntax(code) {
  if (typeof code !== 'string') return code;
  let cleaned = code;
  // Replace `:= begin ... end` with `:= by ...`
  cleaned = cleaned.replace(/(:=\s*)begin\b([\s\S]*?)\bend/g, (_m, p1, p2) => {
    const lines = p2.split('\n').map(l => l.replace(/,\s*$/, ''));
    return `${p1}by\n${lines.join('\n')}`;
  });
  // Replace standalone `begin ... end`
  cleaned = cleaned.replace(/\bbegin\b([\s\S]*?)\bend\b/g, (_m, p1) => {
    const lines = p1.split('\n').map(l => l.replace(/,\s*$/, ''));
    return `by\n${lines.join('\n')}`;
  });
  // Replace `eq.refl a` with `rfl`
  cleaned = cleaned.replace(/\beq\.refl\b(\s+\w+)?/g, 'rfl');
  // Replace `eq.symm` with `Eq.symm`
  cleaned = cleaned.replace(/\beq\.symm\b/g, 'Eq.symm');
  // Strip trailing commas from tactic lines (Lean 3 habit)
  cleaned = cleaned.replace(/(^\s*(?:intro|simp|exact|rw|cases|apply|assumption|refine|constructor|omega|aesop|rfl)[^\n]*?),\s*$/gm, '$1');
  return cleaned;
}

function normalizeUpdatedCode(candidate, fallback = '') {
  if (typeof candidate !== 'string') {
    return fallback;
  }

  const trimmed = candidate.trim();
  if (!trimmed) {
    return fallback;
  }

  const clean = cleanLean3Syntax(cleanCodeFence(trimmed));
  return looksLikeLeanCode(clean) ? clean : (looksLikeLeanCode(trimmed) ? cleanLean3Syntax(trimmed) : fallback);
}

function buildPatchPrompt(message, code, validationSummary = '', conversationContext = '', mode = 'lean') {
  const validationContext = validationSummary ? `\nCurrent validation feedback:\n${validationSummary}` : '';
  const contextPrefix = (conversationContext && !message.includes('Conversation context:')) ? `${conversationContext.trim()}\n\n` : '';

  // For conversational / general queries — do NOT enforce JSON or code output
  if (mode === 'chat') {
    return `Answer the user's latest message naturally and concisely. Use the conversation and current Lean editor contents to understand what they mean. Do not modify or rewrite code in a chat response.
Return ONLY valid JSON with this shape:
{"response":"A concise answer tailored to the user and their current code.","suggestions":["A relevant follow-up request the user could ask"]}
Provide up to three short, specific follow-up requests in "suggestions". They must follow from the user's intent and the actual code or answer. Do not return generic tactic names, keyword lists, or unrelated actions.
${contextPrefix}Latest user message: ${message}
${code ? `\nCurrent Lean code in editor:\n${code}` : '\nThe editor is currently empty.'}`;
  }

  return `You are an expert Lean 4 proof assistant and coding agent.
Strict Lean 4 Rules:
1. Output valid LEAN 4 syntax only. NEVER use Lean 3 syntax (no "begin ... end", no commas between tactics).
2. Proofs start with ":= by" (or direct term ":= ..."). Each tactic goes on its own line indented by 2 spaces.
3. Common Lean 4 closing tactics: "rfl", "simp", "omega", "aesop", "exact <term>", "decide".
4. When asked to prove, simplify, formalize, or edit code, write the complete, compilable Lean 4 source in "updatedCode".

Example valid Lean 4:
import Mathlib

theorem add_zero (n : Nat) : n + 0 = n := by
  rfl

example (a b : Nat) : a + b = b + a := by
  omega

Return ONLY valid JSON matching this exact structure:
{
  "response": "clear, concise explanation of the change",
  "proofState": "current goal or summary of proof state",
  "suggestions": ["A relevant follow-up request about this code or proof"],
  "updatedCode": "full updated Lean source code"
}
Important:
- "updatedCode" must contain the complete, compilable Lean 4 source code as a valid JSON string (use \\n for newlines, do not use markdown fences).
- Do not write any conversational text or explanation outside the JSON object.
- "suggestions" should contain up to three short follow-up requests tailored to the user's intent and current Lean code.
${contextPrefix}User request: ${message}
Current Lean code:
${code || '(empty editor)'}${validationContext}`;
}

async function validateModelPatch(originalCode, candidateCode, message, provider) {
  const nextCode = normalizeUpdatedCode(candidateCode, originalCode);

  if (typeof nextCode !== 'string' || !nextCode.trim() || !/\b(import|theorem|example|lemma|def|:=|by)\b/.test(nextCode)) {
    return {
      ok: true,
      updatedCode: originalCode,
      validation: { ok: true, errors: [], warnings: [], details: ['No valid Lean patch returned; preserved the original code.'], proofState: 'Goal: retain the last valid Lean state and continue with the safest next tactic.' },
      note: `Accepted the last valid Lean state because the model did not return a valid patch for ${provider}.`
    };
  }

  const analysis = await compileLeanCode(nextCode);

  if (analysis.ok) {
    return {
      ok: true,
      updatedCode: nextCode,
      validation: analysis,
      note: `Validated by recompiling with ${provider}.`
    };
  }

  const validationSummary = (analysis.errors || []).map((item) => `${item.line ? `L${item.line}: ` : ''}${item.message}`).join('\n');
  return {
    ok: false,
    updatedCode: nextCode,
    validation: analysis,
    validationSummary,
    note: `Compilation reported diagnostics after model patch; candidate code preserved.`,
    message
  };
}

async function callOpenAIProvider({ message, code, provider, mode = 'lean' }) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const endpoint = 'https://api.openai.com/v1/chat/completions';

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: mode === 'chat'
            ? 'You are a thoughtful Lean 4 coding assistant. Use the current code and conversation to answer the user. Return JSON only with a concise response and up to three code- and intent-specific follow-up requests in suggestions. Do not return generic tactic keywords or modify code.'
            : 'You are a Lean 4 assistant for a browser editor. Use the project context and current code to help refine proofs. Return JSON only with keys: response, suggestions, proofState, and updatedCode. If the current code is already valid, return the same code in updatedCode.'
        },
        {
          role: 'user',
          content: buildPatchPrompt(message, code, '', '', mode)
        }
      ]
    })
  }, 20000);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = parseToolAwareJson(content);

  if (parsed) {
    return {
      ok: true,
      response: parsed.response || parsed.content || content,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : (mode === 'chat' ? [] : ['intro h', 'simp', 'exact rfl']),
      proofState: parsed.proofState || 'Goal: validate the current theorem with the most direct supported tactic.',
      streamText: parsed.response || parsed.content || content,
      updatedCode: mode === 'chat' ? null : parsed.updatedCode || null,
      provider
    };
  }

  return {
    ok: true,
    response: content,
    suggestions: mode === 'chat' ? [] : ['intro h', 'simp', 'exact rfl'],
    proofState: 'Goal: refine the theorem using direct Lean tactics.',
    streamText: content,
    provider
  };
}

async function callAzureOpenAIProvider({ message, code, provider, mode = 'lean' }) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';

  if (!endpoint || !apiKey) {
    throw new Error('Azure OpenAI is not configured.');
  }

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: mode === 'chat'
            ? 'You are a thoughtful Lean 4 coding assistant. Use the current code and conversation to answer the user. Return JSON only with a concise response and up to three code- and intent-specific follow-up requests in suggestions. Do not return generic tactic keywords or modify code.'
            : 'You are a Lean 4 assistant. Return JSON only with keys: response, suggestions, proofState, and updatedCode. If the current code is already valid, keep it unchanged.'
        },
        {
          role: 'user',
          content: buildPatchPrompt(message, code, '', '', mode)
        }
      ],
      max_tokens: 700,
      temperature: 0.2
    })
  }, 20000);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure OpenAI request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = parseToolAwareJson(content);

  if (parsed) {
    return {
      ok: true,
      response: parsed.response || content,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : (mode === 'chat' ? [] : ['intro h', 'simp', 'exact rfl']),
      proofState: parsed.proofState || 'Goal: prove the theorem using the simplest valid Lean step.',
      streamText: parsed.response || content,
      updatedCode: mode === 'chat' ? null : parsed.updatedCode || null,
      provider
    };
  }

  return {
    ok: true,
    response: content,
    suggestions: mode === 'chat' ? [] : ['intro h', 'simp', 'exact rfl'],
    proofState: 'Goal: refine the theorem with the direct valid Lean tactic.',
    streamText: content,
    provider
  };
}

async function callOllamaProvider({ message, code, provider, mode = 'lean' }) {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.1';

  const response = await fetchWithTimeout(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: buildPatchPrompt(message, code, '', '', mode),
      stream: false
    })
  }, 20000);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.response || '';
  const parsed = parseToolAwareJson(content);

  if (parsed) {
    return {
      ok: true,
      response: parsed.response || content,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : (mode === 'chat' ? [] : ['intro h', 'simp', 'exact rfl']),
      proofState: parsed.proofState || 'Goal: refine the theorem to the simplest proof state.',
      streamText: parsed.response || content,
      updatedCode: mode === 'chat' ? null : parsed.updatedCode || null,
      provider
    };
  }

  return {
    ok: true,
    response: content,
    suggestions: mode === 'chat' ? [] : ['intro h', 'simp', 'exact rfl'],
    proofState: 'Goal: refine the theorem using Lean tactics that match the target.',
    streamText: content,
    provider
  };
}

async function generateAiResponse({ message, code, provider = DEFAULT_PROVIDER, conversationContext = '', onProgress = null }) {
  const selectedProvider = AI_PROVIDERS.includes(provider) ? provider : DEFAULT_PROVIDER;
  // Use the raw message (not prefixed with history) for intent detection
  const action = decideAgentAction(message, code);
  const effectiveMessage = conversationContext ? `${conversationContext}\nLatest user request: ${message}` : message;

  if (onProgress) onProgress(`Thinking with ${PROVIDER_LABELS[selectedProvider] || selectedProvider}...`);

  // ── Chat / greeting path — never touches code ──────────────────────────────
  if (action === 'chat' || action === 'llm') {
    if (selectedProvider === 'heuristic') {
      return { ...buildChatResponse(message, code, selectedProvider), suggestions: [], decision: action };
    }
    // Conversational and guidance requests should not be treated as code patches.
    try {
      let payload;
      if (selectedProvider === 'academic-cloud') {
        if (!process.env.ACADEMIC_CLOUD_API_KEY) throw new Error('ACADEMIC_CLOUD_API_KEY is not configured.');
        payload = await callAcademicCloudProvider({ message: effectiveMessage, code, provider: selectedProvider, mode: 'chat' });
      } else if (selectedProvider === 'openai') {
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
        payload = await callOpenAIProvider({ message: effectiveMessage, code, provider: selectedProvider, mode: 'chat' });
      } else if (selectedProvider === 'azure-openai') {
        payload = await callAzureOpenAIProvider({ message: effectiveMessage, code, provider: selectedProvider, mode: 'chat' });
      } else if (selectedProvider === 'ollama') {
        payload = await callOllamaProvider({ message: effectiveMessage, code, provider: selectedProvider, mode: 'chat' });
      } else {
        throw new Error(`${PROVIDER_LABELS[selectedProvider] || selectedProvider} is not configured.`);
      }

      const chatResp = buildChatResponse(message, code, selectedProvider);
      return {
        ...chatResp,
        ...payload,
        response: payload.response || chatResp.response,
        streamText: payload.response || payload.streamText || chatResp.response,
        suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
        updatedCode: null,
        decision: action
      };
    } catch (error) {
      console.error('LLM chat request failed:', error && (error.stack || error.message || String(error)));
      const providerLabel = PROVIDER_LABELS[selectedProvider] || selectedProvider;
      const reason = error?.message?.includes('is not configured')
        ? error.message
        : `${providerLabel} request failed. Check the backend logs and provider settings.`;
      return {
        ok: false,
        response: `${providerLabel} is unavailable: ${reason}`,
        streamText: `${providerLabel} is unavailable: ${reason}`,
        suggestions: [],
        provider: selectedProvider,
        decision: action,
        updatedCode: null
      };
    }
  }

  // ── MCP Direct Tool Invocations ───────────────────────────────────────────
  if (action === 'mcp_status') {
    try {
      const status = await mcpClient.getServerStatus();
      const ready = status.status === 'ready' || status.lean_available;
      const response = `🔍 **QEDAI & Lean 4 Server Status** (MCP \`${mcpClient.url}\`):\n` +
        `- **Status**: ${status.status || (ready ? 'Ready' : 'Unavailable')}\n` +
        `- **Lean 4**: ${status.lean_available ? '✅ Available' : '❌ Not Available'}\n` +
        `- **Lake**: ${status.lake_available ? '✅ Available' : '❌ Not Available'}\n` +
        `- **Mathlib**: ${status.mathlib_available ? '✅ Available' : '❌ Not Available'}\n` +
        `- **Model Configured**: ${status.model_configured ? '✅ Yes' : '⚠️ No'}\n` +
        (status.blockers?.length ? `- **Blockers**: ${status.blockers.join(', ')}\n` : '');

      return {
        ok: true,
        response,
        streamText: response,
        agent: `McpAgent:${selectedProvider}`,
        suggestions: ['compile code', 'analyze code', 'suggest tactics'],
        proofState: ready ? 'Lean 4 environment is fully configured and ready.' : 'Lean environment has issues.',
        provider: selectedProvider,
        updatedCode: null,
        decision: action,
        toolsUsed: ['get_server_status']
      };
    } catch (e) {
      const fallbackMsg = `Unable to reach MCP server at ${mcpClient.url}: ${e.message}`;
      return { ok: false, response: fallbackMsg, streamText: fallbackMsg, provider: selectedProvider, decision: action, toolsUsed: ['get_server_status'], updatedCode: null };
    }
  }

  if (action === 'mcp_analyze') {
    try {
      const analysis = await mcpClient.analyzeLeanCode(code);
      const tactics = analysis.tactics_found || [];
      const sorries = analysis.sorry_occurrences || [];
      const response = `📊 **Lean 4 Static Code Analysis**:\n` +
        `- **Total Lines**: ${analysis.total_lines ?? 0}\n` +
        `- **Theorems**: ${analysis.theorem_count ?? 0}\n` +
        `- **Definitions**: ${analysis.definition_count ?? 0}\n` +
        `- **Imports**: ${(analysis.imports || []).join(', ') || 'None'}\n` +
        `- **Tactics Used**: ${tactics.join(', ') || 'None'}\n` +
        `- **Sorries**: ${sorries.length}`;

      return {
        ok: true,
        response,
        streamText: response,
        agent: `McpAgent:${selectedProvider}`,
        suggestions: ['compile code', 'replace sorry with proof', 'suggest tactics'],
        proofState: sorries.length ? `Proof state: contains ${sorries.length} sorry placeholder(s).` : 'Proof state: no sorry placeholders found.',
        provider: selectedProvider,
        updatedCode: null,
        decision: action,
        toolsUsed: ['analyze_lean_code']
      };
    } catch (e) {
      const fallbackMsg = `Analyze code via MCP failed: ${e.message}`;
      return { ok: false, response: fallbackMsg, streamText: fallbackMsg, provider: selectedProvider, decision: action, toolsUsed: ['analyze_lean_code'], updatedCode: null };
    }
  }

  if (action === 'mcp_evaluate') {
    try {
      const evalRes = await mcpClient.evaluateLeanCode(code);
      const response = `🔬 **Lean 4 Evaluation**:\n` +
        `- **Status**: ${evalRes.ok ? '✅ Clean' : '❌ Errors Found'}\n` +
        `- **Errors**: ${evalRes.totalErrors}\n` +
        `- **Warnings**: ${evalRes.totalWarnings}\n` +
        `- **Sorries**: ${evalRes.totalSorries}\n` +
        (evalRes.rawOutput ? `\n\`\`\`text\n${evalRes.rawOutput.trim()}\n\`\`\`` : '');

      return {
        ok: evalRes.ok,
        response,
        streamText: response,
        agent: `McpAgent:${selectedProvider}`,
        suggestions: ['fix errors', 'simplify proof', 'suggest tactics'],
        proofState: evalRes.proofState,
        provider: selectedProvider,
        updatedCode: null,
        decision: action,
        toolsUsed: ['evaluate_lean_code']
      };
    } catch (e) {
      const fallbackMsg = `Evaluate code via MCP failed: ${e.message}`;
      return { ok: false, response: fallbackMsg, streamText: fallbackMsg, provider: selectedProvider, decision: action, toolsUsed: ['evaluate_lean_code'], updatedCode: null };
    }
  }

  if (action === 'mcp_config') {
    try {
      const configRes = await mcpClient.callTool('get_runtime_config', {});
      const cfg = configRes.data || {};
      const response = `⚙️ **QEDAI Runtime Configuration**:\n` +
        Object.entries(cfg).map(([k, v]) => `- **${k}**: ${JSON.stringify(v)}`).join('\n');

      return {
        ok: true,
        response,
        streamText: response,
        agent: `McpAgent:${selectedProvider}`,
        suggestions: ['check server status', 'compile code'],
        proofState: 'Runtime configuration retrieved.',
        provider: selectedProvider,
        updatedCode: null,
        decision: action,
        toolsUsed: ['get_runtime_config']
      };
    } catch (e) {
      const fallbackMsg = `Get runtime config failed: ${e.message}`;
      return { ok: false, response: fallbackMsg, streamText: fallbackMsg, provider: selectedProvider, decision: action, toolsUsed: ['get_runtime_config'], updatedCode: null };
    }
  }

  if (action === 'mcp_solve') {
    try {
      const solveRes = await mcpClient.solveProblem(message);
      const data = solveRes.data || {};
      const generatedCode = typeof data.code === 'string' ? data.code : (typeof data.lean_code === 'string' ? data.lean_code : null);
      if (!solveRes.isError && generatedCode) {
        const response = data.summary || data.message || solveRes.text || 'Executed automated problem solver via MCP.';
        return {
          ok: true,
          response,
          streamText: response,
          agent: `McpSolver:${selectedProvider}`,
          suggestions: ['verify proof', 'simplify proof'],
          proofState: data.proofState || 'Automated proof search complete.',
          provider: selectedProvider,
          updatedCode: generatedCode,
          decision: action,
          toolsUsed: ['solve_problem']
        };
      }
    } catch (_e) {
      // Fall through to LLM code generation path below
    }
  }

  // ── Heuristic path ─────────────────────────────────────────────────────────
  if (selectedProvider === 'heuristic') {
    if (action === 'compiler') {
      const analysis = await compileLeanCode(code);
      return attachAgentInsights({
        ok: analysis.ok,
        response: analysis.ok
          ? '✅ The Lean code is structurally sound and ready for the next proof step.'
          : `❌ Found ${analysis.errors.length} error(s). ${analysis.errors.slice(0, 2).map(e => `L${e.line || 1}: ${e.message}`).join(' | ')}`,
        agent: `LeanCompiler:${selectedProvider}`,
        suggestions: [],
        proofState: analysis.proofState || 'Goal: prove the theorem or refine the remaining target.',
        streamText: analysis.ok ? 'Code is valid.' : 'Compilation errors found.',
        provider: selectedProvider,
        updatedCode: null,  // compile-only — don't touch code
        errors: analysis.errors || [],
        warnings: analysis.warnings || [],
        details: analysis.details || [],
        markers: analysis.markers || [],
        compileResult: analysis,
        decision: action,
        toolsUsed: ['compile_lean_code'],
        note: 'Compiler decision path selected in heuristic mode with MCP.'
      }, code, effectiveMessage);
    }

    const toolDriven = await runMcpToolCycle({ message: effectiveMessage, code, provider: selectedProvider });
    const heuristic = buildHeuristicResponse(message, code, selectedProvider);
    return attachAgentInsights({
      ...heuristic,
      suggestions: [],
      // Only propagate updatedCode if it is actually different from the original
      updatedCode: toolDriven.updatedCode && toolDriven.updatedCode !== code ? toolDriven.updatedCode : null,
      toolsUsed: toolDriven.toolsUsed || ['read_file', 'compile_lean', 'suggest_tactics'],
      decision: action,
      note: 'MCP-style tool orchestration active with heuristic fallback.'
    }, code, effectiveMessage);
  }

  // ── LLM path ───────────────────────────────────────────────────────────────
  try {
    let payload;

    if (selectedProvider === 'openai') {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
      payload = await callOpenAIProvider({ message: effectiveMessage, code, provider: selectedProvider, conversationContext });
    } else if (selectedProvider === 'azure-openai') {
      payload = await callAzureOpenAIProvider({ message: effectiveMessage, code, provider: selectedProvider, conversationContext });
    } else if (selectedProvider === 'ollama') {
      payload = await callOllamaProvider({ message: effectiveMessage, code, provider: selectedProvider, conversationContext });
    } else if (selectedProvider === 'academic-cloud') {
      if (!process.env.ACADEMIC_CLOUD_API_KEY) throw new Error('ACADEMIC_CLOUD_API_KEY is not configured.');
      payload = await callAcademicCloudProvider({ message: effectiveMessage, code, provider: selectedProvider, mode: 'lean', conversationContext });
    }

    // Only run validation + patch if the action involves editing code
    const wantsCodeEdit = ['edit', 'mcp_tool', 'llm', 'mcp_solve'].includes(action);
    if (!wantsCodeEdit || !payload.updatedCode) {
      return attachAgentInsights({
        ...payload,
        updatedCode: null,
        toolsUsed: ['read_file', 'suggest_tactics'],
        decision: action
      }, code, effectiveMessage);
    }

    const candidateCode = normalizeUpdatedCode(payload.updatedCode, code);
    let finalCode = candidateCode;
    let finalProofState = payload.proofState || 'Goal: proof is ready to compile.';
    let validationNote = `Model patch generated with ${selectedProvider}.`;
    const toolsUsed = ['compile_lean_code'];

    let firstValidationResult = null;
    try {
      if (onProgress) onProgress('Verifying generated code with Lean 4 MCP compiler...');
      const firstValidation = await validateModelPatch(code, candidateCode, effectiveMessage, selectedProvider);
      if (firstValidation.validation) {
        firstValidationResult = firstValidation.validation;
      }
      if (firstValidation.ok) {
        finalCode = firstValidation.updatedCode || candidateCode;
        finalProofState = firstValidation.validation?.proofState || 'Goal: proof passed compilation.';
        validationNote = `Validated model patch passed compile with ${selectedProvider}.`;
      } else if (firstValidation.validationSummary) {
        if (onProgress) onProgress('Compiler reported issues; refining Lean 4 code with betterment loop...');
        const bettermentPrompt = `The candidate Lean 4 code produced compiler errors:\n${firstValidation.validationSummary}\nFix the compiler errors and close the goals in the following code:\n${candidateCode}`;
        try {
          const retryPayload = selectedProvider === 'academic-cloud'
            ? await callAcademicCloudProvider({ message: bettermentPrompt, code: candidateCode, provider: selectedProvider, mode: 'lean', conversationContext })
            : selectedProvider === 'openai'
              ? await callOpenAIProvider({ message: bettermentPrompt, code: candidateCode, provider: selectedProvider })
              : selectedProvider === 'azure-openai'
                ? await callAzureOpenAIProvider({ message: bettermentPrompt, code: candidateCode, provider: selectedProvider })
                : await callOllamaProvider({ message: bettermentPrompt, code: candidateCode, provider: selectedProvider });

          if (retryPayload && retryPayload.updatedCode) {
            const retryCode = normalizeUpdatedCode(retryPayload.updatedCode, candidateCode);
            if (retryCode && retryCode !== candidateCode) {
              finalCode = retryCode;
              validationNote = `Refined with Lean 4 betterment via ${selectedProvider}.`;
              if (retryPayload.proofState) finalProofState = retryPayload.proofState;
            }
          }
        } catch (_retryErr) {}
      }
    } catch (_valErr) {}

    // Only compile if we didn't already get validation results
    let finalCompileResult = null;
    if (firstValidationResult && finalCode === candidateCode) {
      finalCompileResult = firstValidationResult;
    } else {
      try {
        if (onProgress) onProgress('Running final Lean 4 diagnostics...');
        finalCompileResult = await compileLeanCode(finalCode || candidateCode || code);
        if (finalCompileResult.proofState) finalProofState = finalCompileResult.proofState;
      } catch (_fcErr) {}
    }

    const isDifferent = finalCode && finalCode.trim() !== (code || '').trim();
    return attachAgentInsights({
      ...payload,
      updatedCode: isDifferent ? finalCode : (candidateCode && candidateCode.trim() !== (code || '').trim() ? candidateCode : finalCode),
      proofState: finalProofState,
      // Forward compilation diagnostics so the UI can update its panels
      compileResult: finalCompileResult || null,
      errors: finalCompileResult?.errors || [],
      warnings: finalCompileResult?.warnings || [],
      details: finalCompileResult?.details || [],
      markers: finalCompileResult?.markers || [],
      ok: finalCompileResult ? finalCompileResult.ok : payload.ok,
      toolsUsed,
      decision: action,
      subAction: finalCode.length > (code || '').length ? 'llm_generate' : 'llm_betterment',
      note: validationNote
    }, finalCode || candidateCode || code, effectiveMessage);
  } catch (_error) {
    console.error('LLM provider failure:', _error && (_error.stack || _error.message || String(_error)));
    const fallback = buildHeuristicResponse(message, code, 'heuristic');
    const toolDriven = await runMcpToolCycle({ message: effectiveMessage, code, provider: 'heuristic' });
    return attachAgentInsights({
      ...fallback,
      suggestions: [],
      updatedCode: toolDriven.updatedCode && toolDriven.updatedCode !== code ? toolDriven.updatedCode : null,
      provider: selectedProvider,
      decision: action,
      toolsUsed: toolDriven.toolsUsed || ['read_file', 'compile_lean', 'suggest_tactics'],
      note: 'LLM provider unavailable; heuristic + MCP fallback used instead.'
    }, code, effectiveMessage);
  }
}



function basicLeanCheck(source) {
  const result = {
    ok: true,
    warnings: [],
    errors: [],
    details: [],
    markers: [],
    proofState: 'Goal: prove the current theorem using the available hypotheses.',
    tacticHints: ['intro', 'simp', 'exact', 'cases', 'rw']
  };

  if (!source || !source.trim()) {
    return {
      ok: false,
      warnings: [],
      errors: [{ message: 'Empty Lean file.', line: 1, column: 1 }],
      details: ['No Lean source was provided.'],
      markers: [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2, message: 'Empty Lean file.', severity: 8 }],
      proofState: 'Goal: no theorem body found yet.',
      tacticHints: ['intro', 'simp', 'exact']
    };
  }

  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (line.includes('theorem') && !line.includes(':=') ) {
      result.errors.push({
        message: 'Incomplete theorem declaration. Add a proof body or a type annotation.',
        line: lineNo,
        column: line.indexOf('theorem') + 1
      });
    }
    if (line.includes('sorry')) {
      result.warnings.push({
        message: 'Proof uses sorry. This is accepted by the checker but not a complete proof.',
        line: lineNo,
        column: line.indexOf('sorry') + 1
      });
    }
    if (line.includes('example') && !line.includes(':=') && !line.includes(':')) {
      result.errors.push({
        message: 'Example statement is missing a type or definition.',
        line: lineNo,
        column: line.indexOf('example') + 1
      });
    }
    if (line.includes('by')) {
      result.proofState = 'Goal: solve the proposition in the current context using tactics that match the conclusion.';
    }
  });

  result.markers = result.errors.map((err) => ({
    startLineNumber: err.line || 1,
    startColumn: err.column || 1,
    endLineNumber: err.line || 1,
    endColumn: (err.column || 1) + 1,
    message: err.message,
    severity: 8
  }));

  if (result.errors.length > 0) {
    result.ok = false;
    result.proofState = 'Proof state: the theorem is not yet fully solved. Reduce the goal and apply the simplest tactic that closes it.';
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    result.details.push('Lean-like source is structurally valid.');
    result.proofState = 'Proof state: the current goal matches the expected shape for a simple theorem. Try refine or simp if needed.';
  }

  return result;
}

function parseLeanOutput(rawOutput, commandFailed) {
  const lines = (rawOutput || '').split(/\r?\n/).filter(Boolean);
  const errors = [];
  const warnings = [];
  const details = [];

  lines.forEach((line) => {
    const match = line.match(/^(.*?):(\d+):(\d+):\s*(error|warning):\s*(.*)$/);
    if (match) {
      const [, file, lineNumber, column, type, message] = match;
      const entry = { file, line: Number(lineNumber), column: Number(column), message: message.trim() };
      if (type === 'warning') warnings.push(entry); else errors.push(entry);
      return;
    }

    const genericError = line.match(/(error|warning):\s*(.*)/i);
    if (genericError) {
      const message = genericError[2].trim();
      if (/warning/i.test(genericError[1])) warnings.push({ message });
      else errors.push({ message });
      return;
    }

    details.push(line.trim());
  });

  return {
    ok: !commandFailed && errors.length === 0,
    errors,
    warnings,
    details: details.length ? details : ['Lean compilation completed.'],
    markers: errors.map((err) => ({
      startLineNumber: err.line || 1,
      startColumn: err.column || 1,
      endLineNumber: err.line || 1,
      endColumn: (err.column || 1) + 1,
      message: err.message,
      severity: 8
    })),
    proofState: errors.length ? 'Proof state: the Lean checker reported at least one remaining error.' : 'Proof state: the Lean file parsed and compiled successfully.',
    tacticHints: ['intro', 'simp', 'exact', 'cases', 'rw']
  };
}

function runLeanCommand(filePath) {
  const timeout = Number(process.env.LEAN_EXEC_TIMEOUT || 15000);
  return new Promise((resolve, reject) => {
    execFile('lean', [filePath], { timeout }, (error, stdout, stderr) => {
      const rawOutput = `${stdout || ''}\n${stderr || ''}`.trim();
      if (error && (error.code === 127 || error.code === 'ENOENT' || error.syscall === 'spawn lean' || error.killed)) {
        reject(new Error('LEAN_NOT_FOUND'));
        return;
      }
      resolve(parseLeanOutput(rawOutput, Boolean(error && error.code !== 0)));
    });
  });
}

function runDockerCommand(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        const output = `${stdout || ''}\n${stderr || ''}`.trim();
        reject(new Error(output || error.message));
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function ensureDockerImage() {
  if (!dockerImageReady) {
    dockerImageReady = (async () => {
      try {
        await runDockerCommand(['image', 'inspect', dockerImage], 10000);
      } catch (_inspectError) {
        await runDockerCommand(['build', '--tag', dockerImage, compilerDir], 300000);
      }
    })().catch((error) => {
      dockerImageReady = null;
      throw new Error(`Unable to prepare the Lean compiler image: ${error.message}`);
    });
  }

  return dockerImageReady;
}

async function runDockerCompile(filePath, tmpDir) {
  try {
    await ensureDockerImage();
    const { stdout, stderr } = await runDockerCommand(
      ['run', '--rm', '-v', `${tmpDir}:/workspace`, dockerImage, `/workspace/${path.basename(filePath)}`],
      120000
    );
    const rawOutput = `${stdout}\n${stderr}`.trim();
    return parseLeanOutput(rawOutput, false);
  } catch (error) {
    return {
      ok: false,
      errors: [{ message: error.message }],
      warnings: [],
      details: ['Docker Lean compilation failed.'],
      markers: [],
      proofState: 'Lean toolchain unavailable; Docker compilation failed.',
      tacticHints: ['intro', 'simp', 'exact', 'cases', 'rw']
    };
  }
}

function hasDockerAvailable() {
  return new Promise((resolve) => {
    execFile('docker', ['--version'], { timeout: 3000 }, (error) => resolve(!error));
  });
}

async function compileLeanCode(source) {
  if (!source || !source.trim()) {
    return basicLeanCheck(source);
  }

  // 1. Primary: Fast local Lean 4 toolchain (runs in ~2-4s)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qedui-lean-'));
  const filePath = path.join(tmpDir, 'Main.lean');
  fs.writeFileSync(filePath, source, 'utf8');

  try {
    const result = await runLeanCommand(filePath);
    return { ...result, source, timestamp: new Date().toISOString() };
  } catch (localError) {
    // 2. If MCP explicitly enabled in .env, fallback to MCP server
    if (process.env.USE_MCP === 'true') {
      try {
        const isMcpOnline = await mcpClient.isAvailable();
        if (isMcpOnline) {
          const mcpResult = await mcpClient.compileLeanCode(source);
          return mcpResult;
        }
      } catch (mcpErr) {
        console.warn('[Compile] MCP verification unavailable:', mcpErr.message);
      }
    }

    const dockerReady = await hasDockerAvailable();
    if (!dockerReady) {
      return {
        ...basicLeanCheck(source),
        source,
        timestamp: new Date().toISOString(),
        details: ['Fast structural Lean 4 validation performed.']
      };
    }

    try {
      const result = await runDockerCompile(filePath, tmpDir);
      return { ...result, source, timestamp: new Date().toISOString() };
    } catch (dockerError) {
      return {
        ...basicLeanCheck(source),
        source,
        timestamp: new Date().toISOString(),
        details: ['Lean toolchain unavailable locally; using local validation fallback.']
      };
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {}
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Lean 4 editor backend is running.' });
});

app.post('/api/compile', async (req, res) => {
  const { code = '' } = req.body;
  const analysis = await compileLeanCode(code);

  res.json({
    ok: analysis.ok,
    source: code,
    warnings: analysis.warnings || [],
    errors: analysis.errors || [],
    details: analysis.details || [],
    markers: analysis.markers || [],
    proofState: analysis.proofState || 'Goal: prove the current theorem using the available hypotheses.',
    tacticHints: analysis.tacticHints || ['intro', 'simp', 'exact', 'cases', 'rw'],
    timestamp: new Date().toISOString()
  });
});

app.post('/api/check', async (req, res) => {
  const { code = '' } = req.body;
  const analysis = await compileLeanCode(code);

  res.json({
    ok: analysis.ok,
    message: analysis.ok ? 'Proof check passed.' : 'Proof check found issues.',
    errors: analysis.errors || [],
    warnings: analysis.warnings || [],
    details: analysis.details || []
  });
});

app.get('/api/ai/providers', (req, res) => {
  const providers = getConfiguredProviders().map((value) => ({
    value,
    label: PROVIDER_LABELS[value] || value,
    default: value === DEFAULT_PROVIDER,
    configured: getProviderStatus(value).configured,
    reason: getProviderStatus(value).reason
  }));

  res.json({
    ok: true,
    providers,
    defaultProvider: providers.some((p) => p.default) ? DEFAULT_PROVIDER : providers[0]?.value || 'heuristic',
    enum: providers.map((p) => p.value)
  });
});

app.get('/api/mcp/status', async (req, res) => {
  try {
    const isOnline = await mcpClient.isAvailable();
    let serverStatus = null;
    let tools = [];
    if (isOnline) {
      serverStatus = await mcpClient.getServerStatus().catch(() => null);
      tools = await mcpClient.getTools().catch(() => []);
    }
    res.json({
      ok: true,
      connected: isOnline,
      url: mcpClient.url,
      serverInfo: mcpClient.serverInfo,
      serverStatus,
      tools: tools.map((t) => ({ name: t.name, description: t.description }))
    });
  } catch (err) {
    res.json({
      ok: false,
      connected: false,
      url: mcpClient.url,
      error: err.message
    });
  }
});

app.post('/api/mcp/call', async (req, res) => {
  const { name, arguments: args = {} } = req.body;
  if (!name) {
    return res.status(400).json({ ok: false, error: 'Tool name is required.' });
  }

  try {
    const result = await mcpClient.callTool(name, args);
    res.json({ ok: !result.isError, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/ai/tools', async (req, res) => {
  let mcpTools = [];
  let isMcpReady = false;
  try {
    isMcpReady = await mcpClient.isAvailable();
    if (isMcpReady) {
      mcpTools = await mcpClient.getTools();
    }
  } catch (_e) {}

  const standardTools = [
    { name: 'llm_code_generation', description: 'Generate complete Lean 4 theorems and proofs from specifications.' },
    { name: 'llm_code_betterment', description: 'Iteratively refine, simplify, golf, and repair Lean 4 proofs using compiler feedback.' },
    { name: 'read_file', description: 'Read the current Lean code from the active editor.' },
    { name: 'suggest_tactics', description: 'Recommend relevant Lean tactics based on user request and goal.' }
  ];

  const formattedMcp = (mcpTools || []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    source: 'mcp'
  }));

  res.json({
    ok: true,
    mcp: {
      url: mcpClient.url,
      connected: isMcpReady,
      serverInfo: mcpClient.serverInfo
    },
    tools: [...formattedMcp, ...standardTools]
  });
});

app.post('/api/ai/chat', async (req, res) => {
  const { message = '', code = '', provider = DEFAULT_PROVIDER, sessionId = null, history = [] } = req.body;
  const sessionHistory = getSessionHistory(sessionId, history);
  const conversationContext = buildSessionContext(sessionHistory);
  const nextMessage = typeof message === 'string' ? message.trim() : '';
  const payload = await generateAiResponse({ message: nextMessage, code, provider, conversationContext });

  if (sessionId) {
    const session = chatSessions.get(sessionId) || { messages: [] };
    session.messages = [...session.messages, { role: 'user', text: nextMessage }, { role: 'assistant', text: String(payload.response || payload.streamText || '') }].slice(-20);
    chatSessions.set(sessionId, session);
  }

  res.json({
    ok: payload.ok !== false,
    response: payload.response,
    agent: payload.agent || 'LeanAssistant',
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
    proofState: payload.proofState || 'Goal: simplify the theorem and close the final target with the shortest tactic.',
    streamText: payload.streamText || payload.response,
    provider: payload.provider || provider,
    updatedCode: payload.updatedCode || null,
    decision: payload.decision || decideAgentAction(nextMessage, code),
    note: payload.note || undefined,
    toolsUsed: payload.toolsUsed || ['read_file', 'compile_lean', 'suggest_tactics'],
    missingThings: payload.missingThings || [],
    improvements: payload.improvements || [],
    nextActions: payload.nextActions || [payload.decision || decideAgentAction(nextMessage, code)],
    sessionId
  });
});

function chunkStreamText(text, chunkSize = 30) {
  const source = String(text || '');
  const chunks = [];

  for (let index = 0; index < source.length; index += chunkSize) {
    chunks.push(source.slice(index, index + chunkSize));
  }

  return chunks.length ? chunks : [''];
}

app.post('/api/ai/chat/stream', async (req, res) => {
  const { message = '', code = '', provider = DEFAULT_PROVIDER, sessionId = null, history = [] } = req.body;
  const sessionHistory = getSessionHistory(sessionId, history);
  const conversationContext = buildSessionContext(sessionHistory);
  const nextMessage = typeof message === 'string' ? message.trim() : '';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send periodic SSE keep-alive comments every 2.5 seconds so browser connection never drops
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (_e) {}
  }, 2500);

  try {
    res.write(`data: ${JSON.stringify({ type: 'start', message: 'Generating Lean response...' })}\n\n`);

    const payload = await generateAiResponse({
      message: nextMessage,
      code,
      provider,
      conversationContext,
      onProgress: (statusMsg) => {
        try {
          res.write(`data: ${JSON.stringify({ type: 'progress', message: statusMsg })}\n\n`);
        } catch (_e) {}
      }
    });

    clearInterval(keepAlive);

    const text = String(payload.response || payload.streamText || payload.message || '');

    if (sessionId) {
      const session = chatSessions.get(sessionId) || { messages: [] };
      const lastMsg = session.messages[session.messages.length - 1];
      if (!lastMsg || lastMsg.text !== text) {
        session.messages = [...session.messages, { role: 'user', text: nextMessage }, { role: 'assistant', text }].slice(-16);
        chatSessions.set(sessionId, session);
      }
    }

    const chunks = chunkStreamText(text, 30);
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    res.write(`data: ${JSON.stringify({ type: 'done', payload: { ...payload, response: text, streamText: text } })}\n\n`);
    res.end();
  } catch (streamErr) {
    clearInterval(keepAlive);
    console.error('Stream error:', streamErr);
    try {
      res.write(`data: ${JSON.stringify({ type: 'done', payload: { ok: false, response: 'An error occurred during AI processing.', streamText: 'An error occurred.', provider } })}\n\n`);
      res.end();
    } catch (_e) {}
  }
});

app.post('/api/ai/edit', async (req, res) => {
  const { message = '', code = '', provider = DEFAULT_PROVIDER } = req.body;
  const payload = await generateAiResponse({ message, code, provider });

  res.json({
    ok: true,
    response: payload.response,
    agent: payload.agent || 'LeanAssistant',
    suggestions: payload.suggestions || ['intro h', 'simp', 'exact rfl'],
    proofState: payload.proofState || 'Goal: simplify the theorem and close the final target with the shortest tactic.',
    updatedCode: payload.updatedCode || code,
    provider: payload.provider || provider,
    decision: payload.decision || decideAgentAction(message, code),
    note: payload.note || undefined
  });
});

app.post('/api/ai/autocomplete', (req, res) => {
  res.json({
    ok: true,
    suggestions: [],
    agent: 'AutocompleteAgent'
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Backend listening on http://localhost:${port}`);
  });
}

module.exports = {
  app,
  compileLeanCode,
  generateAiResponse,
  applyPatchToCode,
  buildHeuristicResponse,
  runMcpToolCycle,
  getConfiguredProviders,
  decideAgentAction,
  buildSessionContext,
  mcpClient,
  DEFAULT_PROVIDER,
  PROVIDER_LABELS,
  callAcademicCloudProvider
};
