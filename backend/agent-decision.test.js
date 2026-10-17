const assert = require('node:assert/strict');
const { decideAgentAction, generateAiResponse, buildSessionContext, DEFAULT_PROVIDER } = require('./server');

assert.equal(DEFAULT_PROVIDER, process.env.AGENT_PROVIDER_DEFAULT || 'academic-cloud');

const code = `import Mathlib

example (n : Nat) : n + 0 = n := by
  simp
`;

assert.equal(decideAgentAction('formalize handshake lemma', code), 'edit');
assert.equal(decideAgentAction('compile this theorem', code), 'compiler');
assert.equal(decideAgentAction('help me prove this', code), 'llm');
assert.equal(decideAgentAction('check server status', code), 'mcp_status');
assert.equal(decideAgentAction('analyze the lean code', code), 'mcp_analyze');
assert.equal(decideAgentAction('evaluate the code', code), 'mcp_evaluate');
assert.equal(decideAgentAction('better this proof to use exact rfl', code), 'edit');

const sessionContext = buildSessionContext([
  { role: 'user', text: 'formalize handshake lemma' },
  { role: 'assistant', text: 'I updated the theorem with a direct proof.' },
  { role: 'user', text: 'now make it shorter' }
]);
assert.match(sessionContext, /formalize handshake lemma/i);
assert.match(sessionContext, /make it shorter/i);

(async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.ACADEMIC_CLOUD_API_KEY;
  const handleMcpFetch = async (_url, options = {}) => {
    let body = {};
    try {
      body = JSON.parse(options.body || '{}');
    } catch (_e) {}

    let result = {};
    if (body.method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'QEDAI Lean 4 Proof Assistant', version: '1.0.0' }
      };
    } else if (body.method === 'tools/call') {
      result = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Lean code compiled successfully',
            output: 'Clean build.'
          })
        }]
      };
    } else if (body.method === 'tools/list') {
      result = {
        tools: [
          { name: 'compile_lean_code', description: 'Compile Lean code' }
        ]
      };
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const lower = String(name).toLowerCase();
          if (lower === 'content-type') return 'application/json';
          if (lower === 'mcp-session-id') return 'mock-session-id';
          return null;
        }
      },
      async json() {
        return { jsonrpc: '2.0', id: body.id, result };
      },
      async text() {
        return JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      }
    };
  };

  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes('/mcp')) {
      return handleMcpFetch(url, options);
    }
    assert.match(requestUrl, /\/v1\/completions|\/chat\/completions|\/api\/generate/);

    const payload = JSON.parse(options.body || '{}');
    assert.equal(payload.model, process.env.ACADEMIC_CLOUD_MODEL || 'meta-llama-3.1-8b-instruct');

    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
        }
      },
      async json() {
        return {
          choices: [{
            text: '  exact rfl\n\nlemma handshake_lemma (a b c : Nat) : a + 0 = a := by\n  simp\n'
          }]
        };
      },
      async text() {
        return JSON.stringify({
          choices: [{
            text: '  exact rfl\n\nlemma handshake_lemma (a b c : Nat) : a + 0 = a := by\n  simp\n'
          }]
        });
      }
    };
  };

  try {
    const insight = await generateAiResponse({
      message: 'formalize handshake lemma',
      code,
      provider: 'academic-cloud'
    });

    assert.equal(insight.decision, 'edit');
    assert.ok(Array.isArray(insight.nextActions) || Array.isArray(insight.toolsUsed));
    assert.ok(Array.isArray(insight.missingThings) || Array.isArray(insight.improvements));
    assert.ok(insight.updatedCode && /(?:import|theorem|example|lemma|def|:=|by)/i.test(insight.updatedCode));

    global.fetch = async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/mcp')) {
        return handleMcpFetch(url, options);
      }
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
          }
        },
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  response: 'Formalized handshake lemma',
                  proofState: 'Goal: prove n + 0 = n',
                  suggestions: ['rw [add_zero]'],
                  updatedCode: 'import Mathlib\n\nexample (n : Nat) : n + 0 = n := by\n  rw [add_zero]\n'
                })
              }
            }]
          };
        },
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  response: 'Formalized handshake lemma',
                  proofState: 'Goal: prove n + 0 = n',
                  suggestions: ['rw [add_zero]'],
                  updatedCode: 'import Mathlib\n\nexample (n : Nat) : n + 0 = n := by\n  rw [add_zero]\n'
                })
              }
            }]
          });
        }
      };
    };

    const nestedInsight = await generateAiResponse({
      message: 'formalize handshake lemma',
      code,
      provider: 'academic-cloud'
    });

    assert.equal(nestedInsight.response, 'Formalized handshake lemma');
    assert.ok(typeof nestedInsight.updatedCode === 'string');
    assert.match(nestedInsight.updatedCode, /import Mathlib/i);

    process.env.ACADEMIC_CLOUD_API_KEY = 'test-key';
    let chatRequest;
    global.fetch = async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/mcp')) {
        return handleMcpFetch(url, options);
      }
      chatRequest = JSON.parse(options.body || '{}');
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
          }
        },
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  response: 'The goal is solved by simp because Nat addition by zero reduces definitionally.',
                  suggestions: ['Ask me to explain why simp closes this exact goal.', 'Try a version that uses rw [Nat.add_zero].']
                })
              }
            }]
          };
        },
        async text() {
          return '';
        }
      };
    };

    const contextualChat = await generateAiResponse({
      message: 'Why does this proof close immediately?',
      code,
      provider: 'academic-cloud',
      conversationContext: 'User: Please explain my natural-number example.'
    });

    assert.equal(contextualChat.ok, true);
    assert.equal(contextualChat.decision, 'llm');
    assert.equal(contextualChat.updatedCode, null);
    assert.match(chatRequest.messages[1].content, /Please explain my natural-number example/);
    assert.match(chatRequest.messages[1].content, /example \(n : Nat\)/);
    assert.deepEqual(contextualChat.suggestions, [
      'Ask me to explain why simp closes this exact goal.',
      'Try a version that uses rw [Nat.add_zero].'
    ]);
    console.log('agent decision tests passed');
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ACADEMIC_CLOUD_API_KEY;
    else process.env.ACADEMIC_CLOUD_API_KEY = originalApiKey;
  }
})();
