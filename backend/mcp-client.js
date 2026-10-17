/**
 * MCP (Model Context Protocol) Client for QEDUI
 * Connects to QEDAI / Lean 4 MCP Server over HTTP SSE transport
 * Default endpoint: http://127.0.0.1:8000/mcp
 */

const DEFAULT_MCP_URL = process.env.MCP_SERVER_URL || 'http://127.0.0.1:8000/mcp';

class McpClient {
  constructor(url = DEFAULT_MCP_URL) {
    this.url = url;
    this.sessionId = null;
    this.serverInfo = null;
    this.capabilities = null;
    this.instructions = '';
    this.cachedTools = null;
    this.lastToolsFetch = 0;
    this.initPromise = null;
    this.requestId = 1;
  }

  /**
   * Helper to execute fetch with timeout
   */
  async _fetch(url, options = {}, timeoutMs = 90000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse Server-Sent Events (SSE) stream or JSON from MCP response
   */
  async _parseResponse(response) {
    const contentType = response.headers.get('content-type') || '';

    // If standard JSON
    if (contentType.includes('application/json')) {
      return await response.json();
    }

    // If text/event-stream or chunked text
    const text = await response.text();
    return this._parseSseText(text);
  }

  _parseSseText(text) {
    const lines = text.split(/\r?\n/);
    let lastData = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr) {
          try {
            lastData = JSON.parse(jsonStr);
          } catch (_e) {
            // Ignore partial or non-json data
          }
        }
      }
    }

    if (lastData) {
      return lastData;
    }

    // Try parsing raw text if it looks like JSON
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch (_e) {}
    }

    throw new Error(`Unable to parse MCP response: ${text.slice(0, 300)}`);
  }

  /**
   * Initialize MCP session with handshake
   */
  async initialize(force = false) {
    if (this.initPromise && !force) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        const id = ++this.requestId;
        const res = await this._fetch(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'qedui-client', version: '1.0.0' }
            }
          })
        }, 15000);

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`MCP initialize failed: HTTP ${res.status} - ${errText}`);
        }

        const newSessionId = res.headers.get('mcp-session-id');
        if (newSessionId) {
          this.sessionId = newSessionId;
        }

        const data = await this._parseResponse(res);
        if (data.error) {
          throw new Error(`MCP initialize error: ${data.error.message || JSON.stringify(data.error)}`);
        }

        const result = data.result || {};
        this.serverInfo = result.serverInfo || null;
        this.capabilities = result.capabilities || null;
        this.instructions = result.instructions || '';

        // Send notifications/initialized
        await this._fetch(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          })
        }, 10000).catch(() => {});

        return {
          ok: true,
          sessionId: this.sessionId,
          serverInfo: this.serverInfo,
          instructions: this.instructions
        };
      } catch (err) {
        this.sessionId = null;
        throw err;
      }
    })();

    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  /**
   * Check if MCP server is online and responding
   */
  async isAvailable() {
    try {
      if (!this.sessionId) {
        await this.initialize();
      }
      return true;
    } catch (_err) {
      return false;
    }
  }

  /**
   * Send a JSON-RPC request to the MCP server
   */
  async request(method, params = {}, timeoutMs = 90000, retryOnSessionError = true) {
    if (!this.sessionId) {
      await this.initialize();
    }

    const id = ++this.requestId;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    try {
      const res = await this._fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params
        })
      }, timeoutMs);

      if (!res.ok) {
        if ((res.status === 400 || res.status === 404) && retryOnSessionError) {
          // Session may have expired on server restart, re-initialize and retry once
          this.sessionId = null;
          await this.initialize(true);
          return await this.request(method, params, timeoutMs, false);
        }
        const text = await res.text().catch(() => '');
        throw new Error(`MCP request '${method}' failed: HTTP ${res.status} ${text}`);
      }

      // Check if session ID was refreshed
      const refreshedSessionId = res.headers.get('mcp-session-id');
      if (refreshedSessionId) {
        this.sessionId = refreshedSessionId;
      }

      const parsed = await this._parseResponse(res);
      if (parsed.error) {
        if (parsed.error.message?.includes('session') && retryOnSessionError) {
          this.sessionId = null;
          await this.initialize(true);
          return await this.request(method, params, timeoutMs, false);
        }
        throw new Error(`MCP error [${parsed.error.code}]: ${parsed.error.message}`);
      }

      return parsed.result;
    } catch (err) {
      if (retryOnSessionError && (err.message.includes('fetch') || err.message.includes('session'))) {
        try {
          this.sessionId = null;
          await this.initialize(true);
          return await this.request(method, params, timeoutMs, false);
        } catch (_retryErr) {
          throw err;
        }
      }
      throw err;
    }
  }

  /**
   * List available tools from the MCP server
   */
  async getTools(forceRefresh = false) {
    const now = Date.now();
    if (this.cachedTools && !forceRefresh && (now - this.lastToolsFetch < 30000)) {
      return this.cachedTools;
    }

    try {
      const result = await this.request('tools/list', {}, 15000);
      const tools = result?.tools || [];
      this.cachedTools = tools;
      this.lastToolsFetch = now;
      return tools;
    } catch (err) {
      if (this.cachedTools) return this.cachedTools;
      throw err;
    }
  }

  /**
   * Call a tool on the MCP server
   */
  async callTool(name, args = {}, timeoutMs = 90000) {
    const result = await this.request('tools/call', {
      name,
      arguments: args
    }, timeoutMs);

    // Extract text content and structuredContent
    let textOutput = '';
    let structuredContent = result?.structuredContent || null;

    if (Array.isArray(result?.content)) {
      for (const item of result.content) {
        if (item.type === 'text' && typeof item.text === 'string') {
          textOutput += item.text;
          if (!structuredContent) {
            try {
              structuredContent = JSON.parse(item.text);
            } catch (_e) {}
          }
        }
      }
    }

    return {
      isError: Boolean(result?.isError),
      text: textOutput,
      data: structuredContent || result,
      raw: result
    };
  }

  /**
   * Compile and analyze Lean 4 code via MCP
   * Uses evaluate_lean_code for fast diagnostics or compile_lean_code
   */
  async compileLeanCode(code) {
    try {
      const res = await this.callTool('evaluate_lean_code', { lean_code: code }, 90000);
      const data = res.data || {};
      const totalErrors = data.TotalErrors ?? 0;
      const totalSorries = data.TotalSorries ?? 0;
      const totalWarnings = data.TotalWarnings ?? 0;
      const rawOutput = data.raw_output || res.text || '';
      const isOk = !res.isError && (data.success !== false) && totalErrors === 0;

      const parsedErrors = [];
      const parsedWarnings = [];
      const lines = rawOutput.split(/\r?\n/);

      for (const line of lines) {
        const errMatch = line.match(/^(.*?):(\d+):(\d+):\s*error:\s*(.*)$/);
        if (errMatch) {
          parsedErrors.push({
            file: errMatch[1],
            line: Number(errMatch[2]),
            column: Number(errMatch[3]),
            message: errMatch[4].trim()
          });
          continue;
        }
        const warnMatch = line.match(/^(.*?):(\d+):(\d+):\s*warning:\s*(.*)$/);
        if (warnMatch) {
          parsedWarnings.push({
            file: warnMatch[1],
            line: Number(warnMatch[2]),
            column: Number(warnMatch[3]),
            message: warnMatch[4].trim()
          });
        }
      }

      if (totalErrors > 0 && parsedErrors.length === 0) {
        if (Array.isArray(data.ErrorDetails) && data.ErrorDetails.length) {
          for (const errStr of data.ErrorDetails) {
            parsedErrors.push({ message: String(errStr), line: 1, column: 1 });
          }
        } else if (rawOutput.trim()) {
          parsedErrors.push({ message: rawOutput.trim(), line: 1, column: 1 });
        } else {
          parsedErrors.push({ message: 'Lean evaluation reported errors.', line: 1, column: 1 });
        }
      }

      const markers = parsedErrors.map((err) => ({
        startLineNumber: err.line || 1,
        startColumn: err.column || 1,
        endLineNumber: err.line || 1,
        endColumn: (err.column || 1) + 1,
        message: err.message || 'Lean compilation error',
        severity: 8
      }));

      let proofState = isOk
        ? 'Proof state: Lean compilation succeeded.'
        : 'Proof state: Lean reported compilation errors.';

      if (rawOutput.includes('⊢')) {
        const goalMatch = rawOutput.match(/⊢[\s\S]*?(?=\n\n|$)/);
        if (goalMatch) {
          proofState = `Goal: ${goalMatch[0].trim()}`;
        }
      }

      return {
        ok: isOk,
        source: code,
        errors: parsedErrors,
        warnings: parsedWarnings,
        details: [
          `MCP Lean 4 verification ${isOk ? 'passed' : 'failed'} (endpoint: ${this.url})`,
          totalSorries > 0 ? `Sorries: ${totalSorries}` : null,
          totalErrors > 0 ? `Errors: ${totalErrors}` : null,
          totalWarnings > 0 ? `Warnings: ${totalWarnings}` : null
        ].filter(Boolean),
        markers,
        proofState,
        tacticHints: ['intro', 'simp', 'exact', 'cases', 'rw', 'omega', 'rfl', 'aesop'],
        sorryUsage: { count: totalSorries },
        rawOutput,
        mcpToolUsed: 'evaluate_lean_code',
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Fast evaluation of Lean 4 code via MCP
   */
  async evaluateLeanCode(leanCode) {
    const res = await this.callTool('evaluate_lean_code', { lean_code: leanCode }, 90000);
    const data = res.data || {};

    const totalErrors = data.TotalErrors ?? (data.errors ? data.errors.length : 0);
    const isOk = !res.isError && (data.success !== false) && totalErrors === 0;

    let proofState = isOk ? 'Proof state: Lean evaluation passed.' : 'Proof state: Evaluation found issues.';
    if (data.raw_output && data.raw_output.includes('⊢')) {
      const goalMatch = data.raw_output.match(/⊢[\s\S]*?(?=\n\n|$)/);
      if (goalMatch) {
        proofState = `Goal: ${goalMatch[0].trim()}`;
      }
    }

    return {
      ok: isOk,
      totalErrors,
      totalWarnings: data.TotalWarnings ?? 0,
      totalSorries: data.TotalSorries ?? 0,
      errorDetails: data.ErrorDetails || [],
      rawOutput: data.raw_output || res.text,
      proofState,
      mcpToolUsed: 'evaluate_lean_code'
    };
  }

  /**
   * Static analysis of Lean 4 code without compiling
   */
  async analyzeLeanCode(leanCode) {
    const res = await this.callTool('analyze_lean_code', { lean_code: leanCode }, 30000);
    return res.data || {};
  }

  /**
   * Full problem solver via MCP
   */
  async solveProblem(problem, options = {}) {
    const args = {
      problem,
      model_name: options.model_name || null,
      max_iterations: options.max_iterations || 3,
      use_multi_agent: options.use_multi_agent ?? true
    };
    return await this.callTool('solve_problem', args, 120000);
  }

  /**
   * Check QEDAI server readiness status
   */
  async getServerStatus() {
    const res = await this.callTool('get_server_status', {}, 15000);
    return res.data || {};
  }
}

const defaultClient = new McpClient();

module.exports = {
  McpClient,
  mcpClient: defaultClient,
  DEFAULT_MCP_URL
};
