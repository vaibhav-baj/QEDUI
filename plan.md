```markdown
# Lean 4 Browser-Based Code Editor Project Plan

## 🎯 Goal
Develop a **browser-based Lean 4 code editor** with:
- Syntax highlighting
- Auto-completion
- Compilation support
- AI agent chat (via MCP backend)

Keep **frontend UI logic** separated from **backend MCP server** for modularity and future enhancements.

---

## 📂 Project Structure

```
lean4-editor/
├── frontend/                # Browser UI (React/Vue + CodeMirror/Monaco)
│   ├── src/
│   │   ├── components/      # Editor, ChatPanel, Toolbar
│   │   ├── services/        # API calls to backend
│   │   └── styles/          # Themes (dark/light)
│   └── package.json
│
├── backend/                 # Lean 4 compiler + MCP server
│   ├── compiler-service/    # Lean 4 Dockerized service
│   │   ├── Dockerfile
│   │   └── api/             # REST endpoints (/compile, /check)
│   ├── mcp-server/          # AI orchestration layer
│   │   ├── agents/          # AutocompleteAgent, ChatAgent
│   │   └── routes/          # API routes for AI features
│   └── requirements.txt
│
└── docs/                    # Documentation + design notes
    └── project-plan.md
```

---

## 🏗️ Development Phases

### Phase 1: Frontend Editor
- Use **CodeMirror 6** or **Monaco Editor**.
- Implement Lean 4 syntax highlighting.
- Add UI components:
  - Editor pane
  - Compilation output pane
  - AI chat sidebar
  - Toolbar (compile, run AI, theme toggle)

### Phase 2: Backend Compiler Service
- Dockerize Lean 4 compiler.
- REST API endpoints:
  - `POST /compile` → compile Lean code
  - `POST /check` → verify proofs
- Return structured JSON errors for frontend highlighting.

### Phase 3: MCP Server
- Build Node.js/Python MCP server.
- Responsibilities:
  - Route AI requests (autocomplete, error explanation, proof strategy).
  - Connect to LLM backend (OpenAI/Azure/Open-source models).
  - Keep logic modular for future agent enhancements.

### Phase 4: AI Agent Features
- **AutocompleteAgent:** Suggest Lean tactics inline.
- **ChatAgent:** Conversational debugging + proof guidance.
- **FormalizationAgent (future):** Convert math text → Lean skeletons.

### Phase 5: Integration
- Frontend calls backend via REST/WebSocket.
- Compilation results + AI responses displayed inline.
- Ensure separation:
  - Frontend = UI only
  - Backend = compiler + MCP orchestration

---

## ⚙️ Tech Stack

- **Frontend:** React/Vue, CodeMirror 6 or Monaco, TailwindCSS
- **Backend Compiler:** Lean 4, Docker, REST API
- **MCP Server:** Node.js/Python, FastAPI/Express
- **AI Agents:** LLM integration (OpenAI/Azure/Open-source)
- **Deployment:** AWS EC2/Kubernetes, Nginx reverse proxy
- Have a readme file which mentions how to start backend and front end/create a script to start both at once
---

