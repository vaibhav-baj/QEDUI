import { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';

const defaultCode = `import Mathlib

example (n : Nat) : n + 0 = n := by
  simp
`;

const backendUrl = 'http://localhost:4000';
const LEAN_KEYWORDS = ['import', 'theorem', 'example', 'by', 'simp', 'exact', 'intro', 'rw', 'cases', 'have', 'match', 'let', 'in', 'Nat', 'Int', 'List', 'Prop', 'Type'];
const LEAN_TACTICS = ['rfl', 'simp', 'omega', 'exact', 'intro', 'rw', 'cases', 'aesop', 'decide', 'assumption', 'refine'];

async function compileCode(code) {
  const response = await fetch(`${backendUrl}/api/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });

  return response.json();
}

async function askAI(message, code, provider = 'academic-cloud', sessionId = null, history = [], stream = false, onChunk = null, onProgress = null) {
  const endpoint = stream ? `${backendUrl}/api/ai/chat/stream` : `${backendUrl}/api/ai/chat`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, code, provider, sessionId, history })
    });

    if (!response.ok) {
      if (stream) {
        return askAI(message, code, provider, sessionId, history, false, null);
      }
      return { ok: false, response: `AI request failed: ${response.status}`, provider };
    }

    if (!stream || !response.body) {
      return response.json();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let payload = null;
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;

        const raw = line.replace(/^data:\s*/, '').trim();
        if (!raw) continue;

        try {
          const event = JSON.parse(raw);

          if (event.type === 'progress' && typeof event.message === 'string') {
            if (onProgress) onProgress(event.message);
          }

          if (event.type === 'chunk' && typeof event.text === 'string') {
            fullText += event.text;
            if (onChunk) onChunk(event.text, fullText);
          }

          if (event.type === 'done' && event.payload) {
            payload = event.payload;
          }
        } catch (_error) {
          // Ignore malformed stream frames.
        }
      }
    }

    if (payload) return payload;
    return { ok: true, response: fullText, streamText: fullText, provider };
  } catch (error) {
    if (stream) {
      try {
        const nonStreamRes = await fetch(`${backendUrl}/api/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, code, provider, sessionId, history })
        });
        if (nonStreamRes.ok) {
          return nonStreamRes.json();
        }
      } catch (_e) {}
    }
    return { ok: false, response: 'The AI service is unavailable right now.', provider };
  }
}

async function fetchProviderOptions() {
  const response = await fetch(`${backendUrl}/api/ai/providers`);
  return response.json();
}

function App() {
  const editorRef = useRef(null);
  const chatListRef = useRef(null);
  const proofStateRef = useRef('Goal: prove the current theorem using available hypotheses.');
  const [sessionId, setSessionId] = useState(() => {
    const storedId = typeof window !== 'undefined' ? window.sessionStorage.getItem('lean4-editor-session-id') : null;
    if (storedId) return storedId;

    const nextId = `lean-session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('lean4-editor-session-id', nextId);
    }
    return nextId;
  });
  const [code, setCode] = useState(defaultCode);
  const [status, setStatus] = useState('Idle');
  const [result, setResult] = useState({ ok: true, errors: [], warnings: [], details: [], proofState: 'Goal: prove the current theorem using available hypotheses.', tacticHints: LEAN_TACTICS });
  const [chat, setChat] = useState([
    { type: 'assistant', text: 'Lean 4 IDE ready. Compile, inspect the proof state, or ask for tactic help.' }
  ]);
  const [input, setInput] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('academic-cloud');
  const [providerOptions, setProviderOptions] = useState([
    { value: 'academic-cloud', label: 'Meta Llama', default: true, configured: true, reason: 'Academic Cloud API key is configured.' },
    { value: 'heuristic', label: 'Local Heuristic', default: false, configured: true, reason: 'Local heuristic engine is always available.' }
  ]);
  const [providerState, setProviderState] = useState('ready');
  const [isBusy, setIsBusy] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const [agentPlan, setAgentPlan] = useState([]);
  const [agentInsights, setAgentInsights] = useState({ missingThings: [], improvements: [] });
  const [agentTrace, setAgentTrace] = useState({ decision: 'idle', provider: selectedProvider, toolsUsed: ['compile_lean'] });
  const [mcpStatus, setMcpStatus] = useState({ connected: false });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('lean4-editor-session-id', sessionId);
    }
  }, [sessionId]);

  useEffect(() => {
    const storedChat = typeof window !== 'undefined' ? window.sessionStorage.getItem('lean4-editor-chat') : null;
    if (!storedChat) return;

    try {
      const parsed = JSON.parse(storedChat);
      if (Array.isArray(parsed) && parsed.length) {
        setChat(parsed);
      }
    } catch (_error) {
      // Ignore invalid cached chat state.
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('lean4-editor-chat', JSON.stringify(chat));
    }
  }, [chat]);

  useEffect(() => {
    const chatList = chatListRef.current;
    if (chatList) {
      chatList.scrollTop = chatList.scrollHeight;
    }
  }, [chat]);

  useEffect(() => {
    const loadProviders = async () => {
      try {
        const payload = await fetchProviderOptions();
        if (Array.isArray(payload.providers) && payload.providers.length) {
          setProviderOptions(payload.providers);
          const preferredProvider = payload.providers.find((provider) => provider.value === 'academic-cloud')
            || payload.providers.find((provider) => provider.default)
            || payload.providers[0];
          const defaultValue = preferredProvider?.value || payload.defaultProvider || 'academic-cloud';
          setSelectedProvider(defaultValue);
        }
      } catch (_error) {
        setProviderOptions([
          { value: 'academic-cloud', label: 'Meta Llama', default: true, configured: false, reason: 'Provider status is unavailable.' },
          { value: 'heuristic', label: 'Local Heuristic', default: false, configured: true, reason: 'Local heuristic engine is always available.' }
        ]);
      }
      try {
        const mcpRes = await fetch(`${backendUrl}/api/mcp/status`);
        if (mcpRes.ok) {
          const mcpData = await mcpRes.json();
          setMcpStatus(mcpData);
        }
      } catch (_e) {}
    };

    loadProviders();
  }, []);

  useEffect(() => {
    const selected = providerOptions.find((provider) => provider.value === selectedProvider);
    const isReady = selected?.configured !== false || selectedProvider === 'heuristic';
    setProviderState(isReady ? 'ready' : 'fallback');
  }, [selectedProvider, providerOptions]);

  useEffect(() => {
    proofStateRef.current = result.proofState || 'Goal: prove the current theorem using available hypotheses.';
  }, [result.proofState]);

  const applySuggestion = (suggestion) => {
    if (!editorRef.current) return;

    const editor = editorRef.current;
    const selection = editor.getSelection();

    editor.executeEdits('lean-agent', [{
      range: selection || { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: suggestion,
      forceMoveMarkers: true
    }]);

    editor.focus();
    setCode(editor.getValue());
  };

  const applyUpdatedCode = (nextCode) => {
    if (!nextCode || typeof nextCode !== 'string') return;

    setCode(nextCode);
    if (editorRef.current) {
      editorRef.current.setValue(nextCode);
    }
  };

  const updateEditorDiagnostics = (monaco, diagnostics) => {
    if (!editorRef.current) return;

    const model = editorRef.current.getModel();
    if (!model) return;

    const markers = diagnostics.map((item) => ({
      startLineNumber: Number(item.line || 1),
      startColumn: Number(item.column || 1),
      endLineNumber: Number(item.line || 1),
      endColumn: Number(item.column || 1) + 1,
      severity: monaco.MarkerSeverity.Error,
      message: item.message || 'Lean diagnostic'
    }));

    monaco.editor.setModelMarkers(model, 'lean4-editor', markers);
  };

  const appendChatMessage = (type, text) => {
    setChat((current) => [...current, { type, text }]);
  };

  const buildChatHistory = (entries = []) => {
    const normalized = Array.isArray(entries) ? entries : [];
    return normalized
      .filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim())
      .map((entry) => ({
        role: entry.type === 'assistant' ? 'assistant' : 'user',
        text: entry.text.trim()
      }));
  };

  const streamAssistantText = (text, onChunk) => {
    const safeText = typeof text === 'string' && text.trim() ? text : 'I can help with that.';
    let partial = '';

    setChat((current) => {
      if (!current.length) return [{ type: 'assistant', text: partial }];
      const clone = [...current];
      const lastMessage = clone[clone.length - 1];

      if (lastMessage && lastMessage.type === 'assistant') {
        clone[clone.length - 1] = { ...lastMessage, text: partial };
      } else {
        clone.push({ type: 'assistant', text: partial });
      }

      return clone;
    });

    const writer = setInterval(() => {
      partial += safeText.slice(partial.length, partial.length + 12);
      setChat((current) => {
        if (!current.length) return [{ type: 'assistant', text: partial }];
        const clone = [...current];
        const lastIndex = clone.length - 1;
        const lastMessage = clone[lastIndex];

        if (lastMessage && lastMessage.type === 'assistant') {
          clone[lastIndex] = { type: 'assistant', text: partial };
        } else {
          clone.push({ type: 'assistant', text: partial });
        }

        return clone;
      });

      if (onChunk) onChunk(partial);
      if (partial.length >= safeText.length) {
        clearInterval(writer);
      }
    }, 18);
  };

  const compile = async () => {
    setIsBusy(true);
    setStatus('Compiling...');

    // Guard: if compile() hangs, update status after timeout to avoid stuck UI during tests
    const compileTimeout = setTimeout(() => {
      setStatus('Compilation timed out');
      setIsBusy(false);
    }, 60000);

    try {
      const payload = await compileCode(code);
      clearTimeout(compileTimeout);
      setResult(payload);
      setStatus(payload.ok ? 'Compilation succeeded' : 'Compilation found errors');
      setAiSuggestions([]);
      setAgentTrace({ decision: 'compiler', provider: selectedProvider, toolsUsed: ['compile_lean'] });

      if (window.monacoEditorInstance) {
        updateEditorDiagnostics(window.monacoEditorInstance, payload.errors || []);
      }

      if (!payload.ok && payload.errors?.length) {
        setChat((current) => [...current, {
          type: 'assistant',
          text: `Diagnostics: ${payload.errors.map((e) => `L${e.line || 1}: ${e.message}`).join(' | ')}`
        }]);
      }
    } catch (error) {
      clearTimeout(compileTimeout);
      setStatus('Compile request failed');
      setResult({ ok: false, errors: [{ message: String(error), line: 1, column: 1 }], warnings: [], details: [], proofState: 'Proof state unavailable.', tacticHints: LEAN_TACTICS });
    } finally {
      setIsBusy(false);
    }
  };

  const sendMessage = async (messageText = input) => {
    if (!messageText.trim()) return;

    const userMessage = messageText.trim();
    const currentChat = [...chat, { type: 'user', text: userMessage }];
    setChat(currentChat);
    setInput('');
    setAiSuggestions([]);
    setIsBusy(true);
    setStatus('Thinking...');

    try {
      const history = buildChatHistory(chat);
      let partialAssistantText = '';

      const payload = await askAI(
        userMessage,
        code,
        selectedProvider,
        sessionId,
        history,
        true,
        (chunk, fullText) => {
          const nextText = fullText || `${partialAssistantText}${chunk}`;
          partialAssistantText = nextText;

          setChat((current) => {
            if (!current.length) return [{ type: 'assistant', text: nextText }];
            const clone = [...current];
            const lastMessage = clone[clone.length - 1];
            if (lastMessage && lastMessage.type === 'assistant') {
              clone[clone.length - 1] = { ...lastMessage, text: nextText };
              return clone;
            }
            clone.push({ type: 'assistant', text: nextText });
            return clone;
          });
        },
        (progressMsg) => setStatus(progressMsg)
      );

      // Sanitize payload: some providers return JSON as a string inside `response` or `updatedCode`.
      const sanitizePayload = (p) => {
        if (!p || typeof p !== 'object') return p || {};

        const cleanCodeFence = (text) => {
          if (typeof text !== 'string') return text;
          return text
            .replace(/^```(?:lean|lean4)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        };

        const tryParse = (value) => {
          if (typeof value !== 'string') return null;
          const trimmed = value.trim();
          if (!trimmed) return null;
          try {
            return JSON.parse(trimmed);
          } catch (_e) {
            const start = trimmed.indexOf('{');
            const end = trimmed.lastIndexOf('}');
            if (start >= 0 && end > start) {
              try {
                return JSON.parse(trimmed.slice(start, end + 1));
              } catch (_e2) {
                try {
                  const replaced = trimmed.slice(start, end + 1).replace(/:\s*`([\s\S]*?)`/g, (_m, p1) => ': ' + JSON.stringify(p1));
                  return JSON.parse(replaced);
                } catch (_e3) {
                  return null;
                }
              }
            }
            return null;
          }
        };

        const out = { ...p };
        const parsedResponse = tryParse(p.response || p.streamText || p.message);
        if (parsedResponse && typeof parsedResponse === 'object') {
          out._parsed = parsedResponse;
          out.response = parsedResponse.response || parsedResponse.message || out.response;
          out.proofState = parsedResponse.proofState || out.proofState;
          out.suggestions = parsedResponse.suggestions || out.suggestions;
          out.updatedCode = parsedResponse.updatedCode || out.updatedCode;
        }

        const parsedUpdated = tryParse(out.updatedCode);
        if (parsedUpdated && typeof parsedUpdated === 'object') {
          out.updatedCode = parsedUpdated.updatedCode || parsedUpdated.code || parsedUpdated;
          if (typeof out.updatedCode === 'object' && out.updatedCode.code) out.updatedCode = out.updatedCode.code;
        }

        if (typeof out.updatedCode === 'string') {
          out.updatedCode = cleanCodeFence(out.updatedCode);
        }

        if (Array.isArray(out.suggestions)) {
          out.suggestions = out.suggestions.map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') return item.tactic || item.label || item.lemma || item.step || JSON.stringify(item);
            return String(item);
          });
        }

        return out;
      };

      const safePayload = sanitizePayload(payload);
      const assistantText = safePayload.response || safePayload.streamText || safePayload.message || 'I can help with that.';
      const suggestions = Array.isArray(safePayload.suggestions)
        ? safePayload.suggestions.filter((item) => typeof item === 'string' && item.trim())
        : [];
      const nextActions = Array.isArray(safePayload.nextActions) && safePayload.nextActions.length
        ? payload.nextActions.filter((item) => item && !['compile', 'inspect proof state', 'suggest tactic', 'compile_lean'].includes(String(item)))
        : Array.isArray(payload.toolsUsed) && payload.toolsUsed.length
          ? payload.toolsUsed.filter((item) => item && !['compile_lean'].includes(String(item)))
          : [];
      const missingThings = Array.isArray(safePayload.missingThings) ? safePayload.missingThings : (Array.isArray(payload.missingThings) ? payload.missingThings : []);
      const improvements = Array.isArray(safePayload.improvements) ? safePayload.improvements : (Array.isArray(payload.improvements) ? payload.improvements : []);

      // Ensure assistant bubble shows the clean formatted text
      setChat((current) => {
        const clone = [...current];
        const lastIndex = clone.length - 1;
        if (lastIndex >= 0 && clone[lastIndex].type === 'assistant') {
          clone[lastIndex] = { ...clone[lastIndex], text: assistantText };
          return clone;
        }
        clone.push({ type: 'assistant', text: assistantText });
        return clone;
      });

      if (
        safePayload.updatedCode &&
        typeof safePayload.updatedCode === 'string' &&
        safePayload.updatedCode.trim() &&
        safePayload.updatedCode.trim() !== code.trim()
      ) {
        applyUpdatedCode(safePayload.updatedCode);
      }

      // Update all result panels (proof state, errors, details, markers) from AI compile diagnostics
      {
        const proofStateText = typeof safePayload.proofState === 'string' && safePayload.proofState
          ? safePayload.proofState
          : typeof safePayload.proofState === 'object' && safePayload.proofState
            ? (safePayload.proofState.statement || safePayload.proofState.goal || JSON.stringify(safePayload.proofState))
            : null;

        const aiErrors = Array.isArray(safePayload.errors) ? safePayload.errors : [];
        const aiDetails = Array.isArray(safePayload.details) && safePayload.details.length ? safePayload.details : [];
        const aiWarnings = Array.isArray(safePayload.warnings) ? safePayload.warnings : [];
        const aiOk = typeof safePayload.ok === 'boolean' ? safePayload.ok : undefined;
        const aiMarkers = Array.isArray(safePayload.markers) ? safePayload.markers : [];

        setResult((current) => ({
          ...current,
          ...(proofStateText ? { proofState: proofStateText } : {}),
          ...(aiErrors.length ? { errors: aiErrors } : {}),
          ...(aiDetails.length ? { details: aiDetails } : {}),
          ...(aiWarnings.length ? { warnings: aiWarnings } : {}),
          ...(aiOk !== undefined ? { ok: aiOk } : {})
        }));

        // Update Monaco editor error markers if we have diagnostics from the AI compile run
        if (aiMarkers.length && window.monacoEditorInstance) {
          updateEditorDiagnostics(window.monacoEditorInstance, aiErrors);
        } else if (aiErrors.length === 0 && safePayload.compileResult && window.monacoEditorInstance) {
          // Clear markers if compile passed
          updateEditorDiagnostics(window.monacoEditorInstance, []);
        }
      }

      setAgentPlan(nextActions);
      setAgentInsights({ missingThings, improvements });
      setAiSuggestions(suggestions);
      setAgentTrace({
        decision: safePayload.decision || payload.decision || 'llm',
        provider: safePayload.provider || payload.provider || selectedProvider,
        toolsUsed: Array.isArray(payload.toolsUsed) && payload.toolsUsed.length ? payload.toolsUsed : ['read_file', 'compile_lean', 'suggest_tactics']
      });
      const decision = safePayload.decision || payload.decision;
      const provider = safePayload.provider || payload.provider || selectedProvider;
      let newStatus;
      if (safePayload.ok === false && !safePayload.compileResult) {
        // Pure AI error (not compile failure)
        newStatus = `AI unavailable • ${provider}`;
      } else if (safePayload.compileResult) {
        // AI generated code and compiled it
        newStatus = safePayload.ok
          ? `✅ Compile passed • ${provider}`
          : `❌ Compile errors • ${provider}`;
      } else if (decision) {
        newStatus = `${decision.toUpperCase()} • ${provider}`;
      } else {
        newStatus = 'Agent ready';
      }
      setStatus(newStatus);
    } catch (error) {
      setChat((current) => [...current, { type: 'assistant', text: 'The AI service is unavailable right now.' }]);
      setStatus('AI request failed');
    } finally {
      setIsBusy(false);
    }
  };

  const autoComplete = async () => {
    await sendMessage('Based on my current Lean code and our conversation, suggest the most useful next step and explain why.');
  };

  const errorBlocks = useMemo(
    () => (result.errors.length ? result.errors : [{ message: 'No errors found.', line: null, column: null }]),
    [result.errors]
  );

  const hasActionableSidebar = agentPlan.length > 0 || agentInsights.missingThings.length > 0 || agentInsights.improvements.length > 0;
  const renderMonacoEditor = (editor, monaco) => {
    editorRef.current = editor;
    window.monacoEditorInstance = monaco;

    monaco.languages.register({ id: 'lean4' });
    monaco.languages.setMonarchTokensProvider('lean4', {
      defaultToken: 'invalid',
      keywords: LEAN_KEYWORDS,
      tokenizer: {
        root: [
          [/\b(import|theorem|example|by|let|in|if|then|else)\b/, 'keyword'],
          [/\b(simp|exact|intro|rw|cases|have|match|constructor|refine|assumption|aesop|omega)\b/, 'keyword'],
          [/\b(Nat|Int|List|Bool|String|Prop|Type)\b/, 'type'],
          [/"(?:[^"\\]|\\.)*"/, 'string'],
          [/'(?:[^'\\]|\\.)*'/, 'string'],
          [/--.*$/, 'comment'],
          [/\b\d+\b/, 'number']
        ]
      }
    });

    // ── Rich Lean 4 completion provider ─────────────────────────────────────
    monaco.languages.registerCompletionItemProvider('lean4', {
      triggerCharacters: ['.', '#', ' ', '\n', '(', '['],

      provideCompletionItems: async (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const linePrefix = model.getValueInRange({
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: 1,
          endColumn: position.column,
        }).trimStart();

        const K = monaco.languages.CompletionItemKind;
        const InsertTextRules = monaco.languages.CompletionItemInsertTextRule;
        const suggestions = [];

        // ── 1. Declaration / top-level snippets ─────────────────────────────
        const isTopLevel = linePrefix.trim() === '' || /^(import|theorem|lemma|def|example|#|structure|class|instance|abbrev|noncomputable)\b/.test(linePrefix);

        const declSnippets = [
          {
            label: 'theorem',
            detail: 'Theorem declaration',
            documentation: 'Declare a named theorem with proof.',
            snippet: 'theorem ${1:name} ${2:(h : ${3:P})} : ${4:Q} := by\n  ${5:sorry}',
          },
          {
            label: 'lemma',
            detail: 'Lemma declaration',
            documentation: 'Declare a named lemma (alias for theorem).',
            snippet: 'lemma ${1:name} ${2:(h : ${3:P})} : ${4:Q} := by\n  ${5:sorry}',
          },
          {
            label: 'example',
            detail: 'Anonymous example',
            documentation: 'Prove an anonymous proposition inline.',
            snippet: 'example ${1:(h : ${2:P})} : ${3:Q} := by\n  ${4:sorry}',
          },
          {
            label: 'def',
            detail: 'Definition',
            documentation: 'Define a new function or value.',
            snippet: 'def ${1:name} ${2:(x : ${3:α})} : ${4:β} :=\n  ${5:_}',
          },
          {
            label: 'structure',
            detail: 'Structure declaration',
            documentation: 'Declare a product-type structure.',
            snippet: 'structure ${1:Name} where\n  ${2:field} : ${3:Type}',
          },
          {
            label: 'class',
            detail: 'Type class',
            documentation: 'Declare a type class.',
            snippet: 'class ${1:Name} (${2:α} : Type*) where\n  ${3:method} : ${4:Type}',
          },
          {
            label: 'instance',
            detail: 'Type class instance',
            documentation: 'Provide an instance of a type class.',
            snippet: 'instance : ${1:ClassName} ${2:α} where\n  ${3:method} := ${4:_}',
          },
          {
            label: 'import Mathlib',
            detail: 'Import all of Mathlib',
            documentation: 'Import the full Mathlib library.',
            snippet: 'import Mathlib\n',
          },
          {
            label: 'import Mathlib.Data.Nat.Basic',
            detail: 'Import Nat basics',
            snippet: 'import Mathlib.Data.Nat.Basic\n',
          },
          {
            label: '#check',
            detail: 'Check type of expression',
            snippet: '#check ${1:expr}',
          },
          {
            label: '#eval',
            detail: 'Evaluate expression',
            snippet: '#eval ${1:expr}',
          },
          {
            label: '#print',
            detail: 'Print definition info',
            snippet: '#print ${1:Name}',
          },
        ];

        for (const d of declSnippets) {
          suggestions.push({
            label: d.label,
            kind: d.label.startsWith('#') ? K.Function : K.Snippet,
            insertText: d.snippet,
            insertTextRules: InsertTextRules.InsertAsSnippet,
            detail: d.detail || '',
            documentation: { value: d.documentation || d.detail || '' },
            range,
          });
        }

        // ── 2. Tactics (with documentation) ─────────────────────────────────
        const tactics = [
          { t: 'intro', doc: 'Introduce hypotheses / function arguments.\n`intro h` introduces `h : P` when goal is `P → Q`.' },
          { t: 'intro h', doc: 'Introduce one named hypothesis.' },
          { t: 'intros', doc: 'Introduce multiple hypotheses at once.' },
          { t: 'simp', doc: 'Simplify the goal using simp lemmas.' },
          { t: 'simp [*]', doc: 'Simplify using all local hypotheses.' },
          { t: 'simp only [${1:lemma}]', doc: 'Simplify using only the specified lemmas.', snippet: true },
          { t: 'exact', doc: 'Close the goal with an exact proof term.\n`exact h` closes the goal if `h` has the right type.' },
          { t: 'exact?', doc: 'Search for an exact proof term in the library.' },
          { t: 'apply', doc: 'Apply a function/lemma to the goal.\n`apply h` when `h : A → B` and goal is `B`.' },
          { t: 'apply?', doc: 'Search for an applicable lemma.' },
          { t: 'rfl', doc: 'Close a goal of the form `a = a`.' },
          { t: 'rw [${1:lemma}]', doc: 'Rewrite goal using an equality lemma.', snippet: true },
          { t: 'rw [← ${1:lemma}]', doc: 'Rewrite goal right-to-left.', snippet: true },
          { t: 'cases ${1:h}', doc: 'Case-split on an inductive value.', snippet: true },
          { t: 'cases h', doc: 'Case-split on hypothesis h.' },
          { t: 'induction ${1:n}', doc: 'Induction on a natural number or inductive type.', snippet: true },
          { t: 'induction n with', doc: 'Structural induction with named cases.' },
          { t: 'constructor', doc: 'Split an And / Iff / Exists goal into parts.' },
          { t: 'refine', doc: 'Partially specify a proof term, leaving holes as goals.' },
          { t: 'refine ⟨${1:_}, ${2:_}⟩', doc: 'Provide parts of a constructor.', snippet: true },
          { t: 'have ${1:h} : ${2:P} := ${3:_}', doc: 'Assert and prove an intermediate fact.', snippet: true },
          { t: 'obtain ⟨${1:a}, ${2:ha}⟩ := ${3:h}', doc: 'Destructure an existential or And hypothesis.', snippet: true },
          { t: 'assumption', doc: 'Close the goal if it matches a hypothesis exactly.' },
          { t: 'contradiction', doc: 'Close the goal from contradictory hypotheses.' },
          { t: 'omega', doc: 'Solve linear arithmetic goals over ℤ and ℕ.' },
          { t: 'ring', doc: 'Prove ring equalities automatically.' },
          { t: 'ring_nf', doc: 'Normalize ring expressions in the goal.' },
          { t: 'linarith', doc: 'Prove linear arithmetic inequalities.' },
          { t: 'norm_num', doc: 'Prove numeric goals by computation.' },
          { t: 'decide', doc: 'Prove decidable propositions by evaluation.' },
          { t: 'aesop', doc: 'Automated extensible search-based prover.' },
          { t: 'tauto', doc: 'Prove propositional tautologies.' },
          { t: 'trivial', doc: 'Close trivially true goals.' },
          { t: 'done', doc: 'Assert the proof is complete (errors if goals remain).' },
          { t: 'sorry', doc: '⚠️ Placeholder — accepts any goal without proof.' },
          { t: 'field_simp', doc: 'Simplify field expressions (clear denominators).' },
          { t: 'push_neg', doc: 'Push negations inward (¬∀ → ∃¬, ¬∃ → ∀¬, etc.).' },
          { t: 'contrapose', doc: 'Switch to the contrapositive of the goal.' },
          { t: 'by_contra ${1:h}', doc: 'Proof by contradiction — introduce ¬goal as h.', snippet: true },
          { t: 'by_cases ${1:h} : ${2:P}', doc: 'Case split on whether P holds.', snippet: true },
          { t: 'split', doc: 'Split on if-then-else or match in the goal.' },
          { t: 'funext', doc: 'Prove function extensionality (f = g ↔ ∀x, f x = g x).' },
          { t: 'ext', doc: 'Apply extensionality lemma.' },
          { t: 'use ${1:x}', doc: 'Provide a witness for an existential goal.', snippet: true },
          { t: 'exists ${1:x}', doc: 'Provide a witness for ∃.', snippet: true },
          { t: 'left', doc: 'Prove left side of an Or goal.' },
          { t: 'right', doc: 'Prove right side of an Or goal.' },
          { t: 'gcongr', doc: 'Prove goals by congruence (generalized).' },
          { t: 'positivity', doc: 'Prove 0 ≤ x or 0 < x goals automatically.' },
          { t: 'norm_cast', doc: 'Normalize numeric coercions (ℕ → ℤ → ℚ, etc.).' },
          { t: 'push_cast', doc: 'Push coercions toward leaves of expressions.' },
          { t: 'simp_rw [${1:lemma}]', doc: 'Rewrite under binders using simp.', snippet: true },
          { t: 'conv => ${1:lhs\n  rw [lemma]}', doc: 'Congruence tactic — rewrite inside subexpressions.', snippet: true },
        ];

        for (const { t, doc, snippet } of tactics) {
          suggestions.push({
            label: t.replace(/\$\{\d+:[^}]*\}/g, '…'),
            kind: K.Keyword,
            insertText: t,
            insertTextRules: (snippet || t.includes('${')) ? InsertTextRules.InsertAsSnippet : undefined,
            detail: 'Lean 4 tactic',
            documentation: { value: doc || '' },
            range,
          });
        }

        // ── 3. Common types and constants ────────────────────────────────────
        const types = [
          { t: 'Nat', doc: 'Natural numbers (ℕ)' },
          { t: 'Int', doc: 'Integers (ℤ)' },
          { t: 'Float', doc: 'Floating point numbers' },
          { t: 'Bool', doc: 'Boolean: true / false' },
          { t: 'String', doc: 'UTF-8 strings' },
          { t: 'Char', doc: 'Unicode character' },
          { t: 'List', doc: 'Linked list type' },
          { t: 'Array', doc: 'Dynamic array type' },
          { t: 'Option', doc: 'Optional value: some x | none' },
          { t: 'Prop', doc: 'Universe of propositions' },
          { t: 'Type', doc: 'Universe of types (Type 0)' },
          { t: 'Type*', doc: 'Universe-polymorphic type' },
          { t: 'Sort', doc: 'Universe (Sort 0 = Prop, Sort 1 = Type)' },
          { t: 'True', doc: 'The trivially true proposition' },
          { t: 'False', doc: 'The false proposition (⊥)' },
          { t: 'And', doc: 'Logical conjunction (P ∧ Q)' },
          { t: 'Or', doc: 'Logical disjunction (P ∨ Q)' },
          { t: 'Not', doc: 'Logical negation (¬P)' },
          { t: 'Iff', doc: 'Logical biconditional (P ↔ Q)' },
          { t: 'Exists', doc: 'Existential quantification (∃ x, P x)' },
        ];

        for (const { t, doc } of types) {
          suggestions.push({
            label: t,
            kind: K.Class,
            insertText: t,
            detail: 'Lean 4 type',
            documentation: { value: doc },
            range,
          });
        }

        // ── 4. Mathlib lemma snippets ────────────────────────────────────────
        const mathlib = [
          { l: 'Nat.add_comm', doc: '`Nat.add_comm : ∀ (n m : ℕ), n + m = m + n`' },
          { l: 'Nat.add_assoc', doc: '`Nat.add_assoc : ∀ (n m k : ℕ), n + m + k = n + (m + k)`' },
          { l: 'Nat.add_zero', doc: '`Nat.add_zero : ∀ (n : ℕ), n + 0 = n`' },
          { l: 'Nat.zero_add', doc: '`Nat.zero_add : ∀ (n : ℕ), 0 + n = n`' },
          { l: 'Nat.mul_comm', doc: '`Nat.mul_comm : ∀ (n m : ℕ), n * m = m * n`' },
          { l: 'Nat.mul_assoc', doc: '`Nat.mul_assoc : ∀ (n m k : ℕ), n * m * k = n * (m * k)`' },
          { l: 'Nat.mul_zero', doc: '`Nat.mul_zero : ∀ (n : ℕ), n * 0 = 0`' },
          { l: 'Nat.zero_mul', doc: '`Nat.zero_mul : ∀ (n : ℕ), 0 * n = 0`' },
          { l: 'Nat.succ_pos', doc: '`Nat.succ_pos : ∀ (n : ℕ), 0 < n + 1`' },
          { l: 'Nat.le_refl', doc: '`Nat.le_refl : ∀ (n : ℕ), n ≤ n`' },
          { l: 'Nat.le_trans', doc: '`Nat.le_trans : n ≤ m → m ≤ k → n ≤ k`' },
          { l: 'List.length_cons', doc: '`List.length_cons : (a :: l).length = l.length + 1`' },
          { l: 'List.append_nil', doc: '`List.append_nil : l ++ [] = l`' },
          { l: 'List.nil_append', doc: '`List.nil_append : [] ++ l = l`' },
          { l: 'Int.add_comm', doc: '`Int.add_comm : ∀ (a b : ℤ), a + b = b + a`' },
          { l: 'mul_comm', doc: '`mul_comm : ∀ (a b : α), a * b = b * a` (general)' },
          { l: 'add_comm', doc: '`add_comm : ∀ (a b : α), a + b = b + a` (general)' },
          { l: 'le_antisymm', doc: '`le_antisymm : a ≤ b → b ≤ a → a = b`' },
          { l: 'lt_of_le_of_lt', doc: '`lt_of_le_of_lt : a ≤ b → b < c → a < c`' },
          { l: 'Finset.sum_comm', doc: 'Commutativity of finite sums.' },
        ];

        for (const { l, doc } of mathlib) {
          suggestions.push({
            label: l,
            kind: K.Reference,
            insertText: l,
            detail: 'Mathlib lemma',
            documentation: { value: doc },
            range,
          });
        }

        // ── 5. AI-powered completions from backend ───────────────────────────
        try {
          const cursorLineText = linePrefix.trim();
          if (cursorLineText.length >= 2) {
            const res = await fetch(`${backendUrl}/api/ai/autocomplete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prefix: cursorLineText }),
            });
            if (res.ok) {
              const data = await res.json();
              for (const s of (data.suggestions || [])) {
                if (typeof s === 'string' && s.trim()) {
                  suggestions.push({
                    label: `⚡ ${s}`,
                    kind: K.Event,
                    insertText: s,
                    detail: 'AI suggestion',
                    documentation: { value: 'Suggested by the AI agent based on your current context.' },
                    sortText: '0_ai_' + s,   // sort AI suggestions to the top
                    range,
                  });
                }
              }
            }
          }
        } catch (_e) {
          // AI completions are best-effort
        }

        return { suggestions };
      },
    });

    // ── Hover provider with richer proof-state info ──────────────────────────
    monaco.languages.registerHoverProvider('lean4', {
      provideHover: (model, position) => {
        const word = model.getWordAtPosition(position);
        if (!word) return null;

        const tacticDocs = {
          simp: '**simp** — Simplify the goal using simp lemma set.',
          exact: '**exact** — Close goal with an exact proof term.',
          intro: '**intro** — Introduce hypotheses from the goal.',
          rw: '**rw** — Rewrite using an equality.',
          cases: '**cases** — Case-split on an inductive value.',
          omega: '**omega** — Solve linear arithmetic over ℤ/ℕ.',
          ring: '**ring** — Prove ring equalities.',
          linarith: '**linarith** — Prove linear inequalities.',
          sorry: '⚠️ **sorry** — Accepts any goal; proof is incomplete.',
          constructor: '**constructor** — Split an And/Iff/Exists goal.',
          assumption: '**assumption** — Close goal matching a hypothesis.',
          decide: '**decide** — Prove decidable props by evaluation.',
          aesop: '**aesop** — Automated proof search.',
          norm_num: '**norm_num** — Prove numeric goals by computation.',
          by: '**by** — Enter tactic mode.',
          theorem: '**theorem** — Declare a named theorem.',
          lemma: '**lemma** — Declare a named lemma.',
          def: '**def** — Define a function or value.',
          example: '**example** — Anonymous proposition proof.',
          Nat: '**Nat** — The type of natural numbers (ℕ = {0, 1, 2, …}).',
          Int: '**Int** — The type of integers (ℤ).',
          Prop: '**Prop** — The universe of propositions.',
          Type: '**Type** — The universe of types.',
        };

        const proofState = proofStateRef.current || 'Goal: solve the current goal.';
        const extraDoc = tacticDocs[word.word];

        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [
            extraDoc ? { value: extraDoc } : { value: `\`${word.word}\`` },
            { value: `---\n**Proof state:** ${proofState}` },
          ],
        };
      },
    });

    monaco.editor.defineTheme('lean4-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: '7dd3fc' },
        { token: 'type', foreground: 'c084fc' },
        { token: 'string', foreground: 'fbbf24' },
        { token: 'comment', foreground: '6ee7b7' },
        { token: 'number', foreground: 'f9a8d4' }
      ],
      colors: {
        'editor.background': '#0f172a',
        'editor.lineHighlightBackground': '#111827',
        'editorCursor.foreground': '#7dd3fc'
      }
    });

    monaco.editor.setTheme('lean4-dark');
    monaco.editor.setModelLanguage(editor.getModel(), 'lean4');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Lean 4</p>
          <h1>Editor Agent</h1>
        </div>
        <div className="toolbar">
          <button data-testid="compile-button" onClick={compile} disabled={isBusy}>{isBusy ? 'Working...' : '⚡ Compile'}</button>
          <button data-testid="suggest-button" className="ghost" onClick={autoComplete} disabled={isBusy}>💡 Suggest next step</button>
          <button className="ghost" onClick={() => sendMessage('Prove this theorem and close all goals.')} disabled={isBusy}>🎯 Auto-Prove</button>
          <button className="ghost" onClick={() => sendMessage('Simplify this proof using simp.')} disabled={isBusy}>simp</button>
          <button className="ghost" onClick={() => sendMessage('Solve this arithmetic equality using omega.')} disabled={isBusy}>omega</button>
        </div>
      </header>

      <main className="workspace">
        <section className="editor-panel panel">
          <Editor
            height="520px"
            defaultLanguage="lean4"
            language="lean4"
            theme="vs-dark"
            value={code}
            options={{
              minimap: { enabled: false },
              fontSize: 15,
              lineNumbersMinChars: 3,
              scrollBeyondLastLine: false,
              roundedSelection: true,
              quickSuggestions: true,
              automaticLayout: true,
              tabSize: 2,
              glyphMargin: true
            }}
            onChange={(value) => setCode(value || '')}
            onMount={renderMonacoEditor}
          />
        </section>

        <aside className="sidebar panel">
          <div className="panel-header">
            <h2>AI Agent</h2>
            <span className="agent-caption">Context-aware Lean help</span>
          </div>

          <div className="agent-controls">
            <div className="provider-label-row">
              <label htmlFor="ai-provider">LLM</label>
              <span className={`provider-badge ${providerState === 'ready' ? 'ready' : 'fallback'}`}>
                {providerState === 'ready' ? 'Connected' : 'Fallback'}
              </span>
            </div>
            <select
              id="ai-provider"
              data-testid="provider-select"
              value={selectedProvider}
              onChange={(event) => setSelectedProvider(event.target.value)}
            >
              {providerOptions.map((provider) => (
                <option key={provider.value} value={provider.value}>{provider.label}</option>
              ))}
            </select>

            <div className="provider-label-row" style={{ marginTop: '8px' }}>
              <label>MCP Server</label>
              <span className={`provider-badge ${mcpStatus?.connected ? 'ready' : 'fallback'}`} title={mcpStatus?.url || 'http://127.0.0.1:8000/mcp'}>
                {mcpStatus?.connected ? 'MCP: Ready' : 'MCP: Offline'}
              </span>
            </div>
          </div>



          <div className="chat-list" ref={chatListRef}>
            {chat.map((entry, index) => (
              <div key={index} className={`chat-bubble ${entry.type}`}>
                {entry.text}
              </div>
            ))}
          </div>

          {aiSuggestions.length > 0 && (
            <div className="chat-suggestions" aria-label="Contextual follow-up suggestions">
              <span className="suggestion-heading">Continue with</span>
              {aiSuggestions.map((item) => (
                <button key={item} className="suggestion-chip" onClick={() => setInput(item)}>
                  {item}
                </button>
              ))}
            </div>
          )}

          <div className="chat-input-row">
            <input
              data-testid="chat-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask about your code or proof..."
              onKeyDown={(event) => {
                if (event.key === 'Enter') sendMessage();
              }}
            />
            <button data-testid="send-button" onClick={() => sendMessage()} disabled={isBusy}>Send</button>
          </div>
        </aside>
      </main>

      <section className="bottom-grid">
        <div className="panel output-panel">
          <div className="panel-header">
            <h2>Status</h2>
            <span className={`status-pill ${result.ok ? 'ok' : 'error'}`}>{status}</span>
          </div>

          <ul className="result-list">
            {errorBlocks.map((item, index) => (
              <li key={index}>
                {item.line ? `Line ${item.line}` : 'Info'}{item.column ? `:${item.column}` : ''} – {item.message}
              </li>
            ))}
          </ul>
        </div>

        <div className="panel output-panel">
          <div className="panel-header">
            <h2>Proof State</h2>
            <span className="agent-caption">Proof tactics</span>
          </div>
          <p className="proof-state">{result.proofState || 'Goal: prove the current theorem using available hypotheses.'}</p>
          <div className="suggestion-row compact">
            {(result.tacticHints || LEAN_TACTICS).map((item) => (
              <button key={item} className="suggestion-chip" onClick={() => applySuggestion(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>

        <div className="panel output-panel">
          <div className="panel-header">
            <h2>Compiler Details</h2>
          </div>

          <ul className="result-list">
            {(result.details.length ? result.details : ['No diagnostics available.']).map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

export default App;
