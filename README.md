# QEDUI: Lean 4 Browser Editor Agent

A full-stack, browser-based Lean 4 development environment and AI-assisted proof engineering studio. Built with **React + Monaco Editor** on the frontend, an **Express.js API** on the backend, and powered by **Lean 4**, **Mathlib**, and **Meta LLaMA 3.1** via Academic Cloud (with optional Model Context Protocol / MCP integration).

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────┐
│                      Frontend UI                       │
│    React 18 + Monaco Editor (Vite @ port 4173)         │
│  - Real-time syntax highlighting for Lean 4            │
│  - In-editor error squiggles & diagnostics             │
│  - Live proof state & compiler details panels          │
│  - Interactive tactic chips & one-click proof actions  │
└───────────────────────────▲────────────────────────────┘
                            │ SSE Stream / REST
┌───────────────────────────▼────────────────────────────┐
│                      Backend API                       │
│              Express.js (@ port 4000)                  │
│  - Intent detection & agent orchestration              │
│  - Multi-turn conversation management                  │
│  - Lean 3 → Lean 4 syntax auto-sanitizer               │
│  - Betterment loop with automated error correction     │
└───────────────┬────────────────────────┬───────────────┘
                │                        │
       Fast Compiler (~4s)       LLM Provider API
                │                        │
┌───────────────▼────────┐      ┌────────▼───────────────┐
│     Native Lean 4      │      │ Academic Cloud / Meta  │
│      Toolchain         │      │ LLaMA 3.1 8B Instruct  │
│  (lean CLI v4.35.0)    │      │ (OpenAI/Ollama option) │
└────────────────────────┘      └────────────────────────┘
```

---

## Prerequisites

Before setting up QEDUI, ensure your system has the following tools installed:

1. **Node.js** (v18.x, v20.x, or v22.x) and **npm**:
   - Verify with:
     ```powershell
     node --version
     npm --version
     ```
2. **Lean 4 Toolchain (`elan`)**:
   - Install `elan` (the Lean version manager) for Windows or Unix:
     ```powershell
     # Windows (via PowerShell)
     curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.ps1 | powershell -c -
     ```
   - Verify `lean` is available in your PATH:
     ```powershell
     lean --version
     # e.g., Lean (version 4.35.0, ...)
     ```
3. **Git**:
   - Verify with: `git --version`

---

## Installation & Setup

### 1. Clone the Repository
```powershell
git clone <repository-url>
cd QEDUI
```

### 2. Install Dependencies
Run the unified installer from the project root:
```powershell
npm run install:all
```
*(Or manually run `npm install` inside both `backend/` and `frontend/` directories.)*

---

## Configuration (`.env`)

Create or update the `.env` file in the root directory (`c:\Users\lenovo\Documents\Git\QEDUI\.env`):

```dotenv
PORT=4000
AGENT_PROVIDER_DEFAULT=academic-cloud
AGENT_PROVIDERS=heuristic,openai,azure-openai,ollama,academic-cloud

# Fast Native Lean 4 Compiler (Recommended: false for fast ~4s local compile)
USE_MCP=false
MCP_SERVER_URL=http://127.0.0.1:8000/mcp

# Lean CLI Execution Timeout (milliseconds)
LEAN_EXEC_TIMEOUT=15000

# Academic Cloud / Meta LLaMA 3.1 Settings
ACADEMIC_CLOUD_ENDPOINT=https://chat-ai.academiccloud.de/v1/completions
ACADEMIC_CLOUD_API_KEY=your_academic_cloud_api_key_here
ACADEMIC_CLOUD_MODEL=meta-llama-3.1-8b-instruct
ACADEMIC_CLOUD_TEMPERATURE=0.2

# Optional: OpenAI Fallback
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

# Optional: Ollama Local Fallback
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
```

---

## Running the Application

### Option A: Start Everything Together (Recommended)

From the project root directory, run:
```powershell
npm run dev
```
This uses `concurrently` to launch both the Express backend and the Vite frontend simultaneously.

Once running:
- **Frontend Web UI:** [http://localhost:4173](http://localhost:4173)
- **Backend API:** [http://localhost:4000](http://localhost:4000)

### Option B: Using the Automated Server Script
```powershell
npm start
# or: node ./scripts/start-servers.js
```
This script handles port cleanup (ports `4000` & `4173`), starts both child processes, and runs automated health probes until both servers are live.

### Option C: Run Services Individually

In Terminal 1 (Backend):
```powershell
cd backend
npm run dev
```

In Terminal 2 (Frontend):
```powershell
cd frontend
npm run dev
```

---

## Key Features & Usage

### 1. Monaco Editor with Lean 4 Integration
- Rich syntax highlighting and auto-completion for Lean 4 keywords and tactics (`simp`, `exact`, `intro`, `rw`, `cases`, `omega`, `rfl`, `aesop`).
- Visual error markers (red squiggles with line/column coordinates and type mismatch details) generated directly from compiler output.

### 2. One-Click Proof Toolbar
Located at the top of the interface:
- **⚡ Compile:** Immediately validates the editor buffer against the native Lean 4 compiler in ~4 seconds.
- **💡 Suggest next step:** Asks the AI for tactical advice without modifying existing code.
- **🎯 Auto-Prove:** Instructs the assistant to write and complete the entire proof automatically.
- **`simp`:** One-click goal simplification.
- **`omega`:** One-click linear integer/natural arithmetic proof resolution.

### 3. Proof State & Diagnostic Panels
- **Status Panel:** Displays overall build health, line-by-line errors, and live progress indicators (`Thinking...`, `Running final diagnostics...`).
- **Proof State Panel:** Shows the active proof goal along with clickable **tactic chips** (`rfl`, `simp`, `omega`, `exact`, `intro`, `rw`, `cases`, `aesop`, `decide`) that insert directly at your editor cursor.
- **Compiler Details Panel:** Raw diagnostic output and typechecker feedback.

### 4. Automated Lean 3 → Lean 4 Sanitizer
The backend features an automatic syntax cleaner (`cleanLean3Syntax`) that dynamically fixes legacy Lean 3 patterns generated by LLMs before passing code to the compiler:
- Rewrites `begin ... end` blocks into clean `by ...` blocks.
- Strips trailing commas from tactic lines.
- Converts `eq.refl` to `rfl` and `eq.symm` to `Eq.symm`.

---

## Project Structure

```
QEDUI/
├── backend/
│   ├── server.js              # Express API, AI routing, Lean compilation pipeline
│   ├── mcp-client.js          # Client for Model Context Protocol (MCP) servers
│   ├── agent-decision.test.js # Test suite for agent routing & multi-turn history
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # Core React UI, Monaco editor setup, SSE chat stream
│   │   ├── main.jsx           # Entry mount point
│   │   └── styles.css         # IDE layout, dark theme, panels, suggestion chips
│   ├── index.html             # Vite entry HTML
│   ├── vite.config.js         # Explicit build & root configuration
│   └── package.json
├── scripts/
│   └── start-servers.js       # Port management & dual-server process launcher
├── .env                       # Environment configuration & API keys
├── package.json               # Root scripts (npm run dev, npm install:all)
└── README.md
```

---

## Running Backend Tests

To run the agent decision test suite:
```powershell
cd backend
node agent-decision.test.js
```

To verify the frontend build:
```powershell
cd frontend
npm run build
```

---

## Troubleshooting

- **Vite: `Could not auto-determine entry point`**:
  Make sure you start the frontend from `frontend/` or run `npm run dev` from the repository root (which executes `vite` with the correct root directory configured in `frontend/vite.config.js`).
- **Port 4000 or 4173 already in use**:
  Run `npm start` (or kill lingering node processes with PowerShell: `Get-Process node | Stop-Process -Force`).
- **Lean compiler not found**:
  Ensure `elan` is installed and `lean` is available in your system's PATH. Running `lean --version` in terminal should output `Lean (version 4.x.x)`.
