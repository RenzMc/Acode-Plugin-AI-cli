import plugin from "../plugin.json";
import style from "./style.scss";

import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { CallbackManager } from "langchain/callbacks";

import copy from "copy-to-clipboard";
import { v4 as uuidv4 } from "uuid";
import { APIKeyManager } from "./api_key";
import { copyIconSvg, sendIconSvg, stopIconSvg } from "./constants";
import { getModelsFromProvider } from "./utils";

const fs = acode.require("fs");
const select = acode.require("select");
const DialogBox = acode.require("dialogBox");
const helpers = acode.require("helpers");
const loader = acode.require("loader");
const sidebarApps = acode.require("sidebarApps");
const toInternalUrl = acode.require("toInternalUrl");
const contextMenu = acode.require("contextMenu");
const selectionMenu = acode.require("selectionMenu");

const AI_HISTORY_PATH = window.DATA_STORAGE + "chatgpt";

let CURRENT_SESSION_FILEPATH = null;

const _tag = typeof tag !== "undefined" ? tag : null;

function createTag(name, props = {}) {
  if (_tag) return _tag(name, props);
  const el = document.createElement(name);
  for (const k in props) {
    const v = props[k];
    if (k === "textContent") el.textContent = v;
    else if (k === "innerHTML") el.innerHTML = v;
    else if (k === "className") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el[k] = v;
  }
  return el;
}

class AIAssistant {
  async init($page, cacheFile, cacheFileUrl) {
    this.$page = $page;
    this.cacheFile = cacheFile;
    this.cacheFileUrl = cacheFileUrl;

    this.$githubDarkFile = createTag("link", {
      rel: "stylesheet",
      href: this.baseUrl + "assets/github-dark.css",
    });
    this.$higlightJsFile = createTag("script", {
      src: this.baseUrl + "assets/highlight.min.js",
    });
    this.$markdownItFile = createTag("script", {
      src: this.baseUrl + "assets/markdown-it.min.js",
    });
    this.$style = createTag("style", {
      textContent: style,
    });

    document.head.append(
      this.$githubDarkFile,
      this.$higlightJsFile,
      this.$markdownItFile,
      this.$style
    );

    this.scriptsLoaded = new Promise((resolve) => {
      let loaded = 0;
      const total = 2;
      const check = () => {
        loaded += 1;
        if (loaded >= total) {
          try {
            if (window.hljs && typeof window.hljs.highlightAll === "function") {
              window.hljs.highlightAll();
            }
          } catch (e) {}
          resolve();
        }
      };
      this.$higlightJsFile.onload = check;
      this.$higlightJsFile.onerror = check;
      this.$markdownItFile.onload = check;
      this.$markdownItFile.onerror = check;
    });

    try {
      await this.scriptsLoaded;
    } catch (e) {}

    this.apiKeyManager = new APIKeyManager("acode-ai-assistant-secret");
    this.sessions = [];
    this.currentSession = null;
    this.currentView = "chat";
    this.isGenerating = false;

    try {
      this.setupSidebar();
    } catch (error) {
      console.error("Sidebar setup failed:", error);
    }

    try {
      this.setupSelectionMenu();
    } catch (error) {
      console.error("Selection menu setup failed:", error);
    }
  }

  setupSidebar() {
    if (!sidebarApps || !acode || !acode.addIcon) return;
    acode.addIcon("ai-assistant-icon", this.baseUrl + "icon.png");
    sidebarApps.add(
      "ai-assistant-icon",
      "ai-assistant-sidebar",
      "AI Assistant",
      (app) => {
        try {
          this.createSidebarContent(app);
        } catch (e) {
          console.error("createSidebarContent error:", e);
        }
      },
      false,
      (app) => {
        try {
          this.onSidebarSelected(app);
        } catch (e) {
          console.error("onSidebarSelected error:", e);
        }
      }
    );
  }

  createSidebarContent(app) {
    if (!app) return;

    app.className = "ai-assistant-sidebar";

    const header = createTag("div", {
      className: "ai-header",
    });

    const nav = createTag("div", {
      className: "ai-nav",
    });

    const chatBtn = createTag("button", {
      className: "ai-nav-btn active",
      textContent: "Chat",
    });
    chatBtn.onclick = () => this.switchView("chat", app);

    const historyBtn = createTag("button", {
      className: "ai-nav-btn",
      textContent: "History",
    });
    historyBtn.onclick = () => this.switchView("history", app);

    const settingsBtn = createTag("button", {
      className: "ai-nav-btn",
      textContent: "Settings",
    });
    settingsBtn.onclick = () => this.switchView("settings", app);

    nav.appendChild(chatBtn);
    nav.appendChild(historyBtn);
    nav.appendChild(settingsBtn);
    header.appendChild(nav);

    const content = createTag("div", {
      className: "ai-content scroll",
    });

    const chatArea = createTag("div", {
      className: "ai-chat-area",
      id: "ai-chat-area",
    });

    const historyArea = createTag("div", {
      className: "ai-history-area",
      id: "ai-history-area",
      style: { display: "none" },
    });

    const settingsArea = createTag("div", {
      className: "ai-settings-area",
      id: "ai-settings-area",
      style: { display: "none" },
    });

    content.appendChild(chatArea);
    content.appendChild(historyArea);
    content.appendChild(settingsArea);

    const welcomeMessage = createTag("div", {
      className: "ai-welcome-message",
      innerHTML: `
        <div class="ai-welcome-content">
          <h3>Welcome to AI Assistant</h3>
          <p>Start a conversation by typing your message below.</p>
        </div>
      `,
    });
    chatArea.appendChild(welcomeMessage);

    const historyTitle = createTag("h3", {
      textContent: "Chat History",
    });

    const historyList = createTag("div", {
      className: "ai-history-list",
    });

    historyArea.appendChild(historyTitle);
    historyArea.appendChild(historyList);

    const settingsForm = createTag("div", {
      className: "ai-settings-form",
      innerHTML: `
        <div class="setting-group">
          <label for="base-url">Base URL</label>
          <input type="text" id="base-url" placeholder="https://api.openai.com/v1" />
        </div>
        <div class="setting-group">
          <label for="api-key">API Key</label>
          <input type="password" id="api-key" placeholder="Enter your API key" />
        </div>
        <div class="setting-group">
          <label for="model-input">Model</label>
          <input type="text" id="model-input" placeholder="gpt-3.5-turbo, gemini-pro, llama2, etc." />
        </div>
        <button type="button" class="save-settings-btn">Save Settings</button>
      `,
    });

    settingsArea.appendChild(settingsForm);

    const saveBtn = settingsForm && settingsForm.querySelector(".save-settings-btn");
    if (saveBtn) saveBtn.onclick = () => this.saveSettings(app);

    this.loadSettings(app).catch((e) => {
      console.error("loadSettings caught:", e);
    });

    const footer = createTag("div", {
      className: "ai-footer",
    });

    const inputContainer = createTag("div", {
      className: "ai-input-container",
    });

    const inputField = createTag("textarea", {
      className: "ai-input",
      placeholder: "Type your message...",
      rows: 1,
    });
    inputField.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage(app);
      }
    };

    const sendBtn = createTag("button", {
      className: "ai-send-btn",
      innerHTML: sendIconSvg,
    });
    sendBtn.onclick = () => this.sendMessage(app);

    inputContainer.appendChild(inputField);
    inputContainer.appendChild(sendBtn);
    footer.appendChild(inputContainer);

    app.appendChild(header);
    app.appendChild(content);
    app.appendChild(footer);

    this.loadChatHistory(app).catch((e) => {
      console.error("loadChatHistory error:", e);
    });
  }

  setupSelectionMenu() {
    if (!selectionMenu) return;
    selectionMenu.add(
      async () => {
        let opt = await select("AI Actions", ["Explain Code", "Rewrite", "Generate Code"], {
          onHide: () => {
            window.toast("Work is in progress...", 3000);
          },
        });
        if (opt) {
          this.handleSelectionAction(opt);
        }
      },
      "✨",
      "all"
    );
  }

  async handleSelectionAction(action) {
    const selectedText = editorManager && editorManager.editor ? editorManager.editor.getSelectedText() : "";
    if (!selectedText) {
      window.toast("Please select some text first", 2000);
      return;
    }

    try {
      const settings = await this.getSettings();
      if (!settings.apiKey || !settings.baseUrl || !settings.model) {
        window.toast("Please configure API settings first", 3000);
        return;
      }

      let promptText = "";
      switch (action) {
        case "Explain Code":
          promptText = `Explain this code:\n\n${selectedText}`;
          break;
        case "Rewrite":
          promptText = `Rewrite this code to be better:\n\n${selectedText}`;
          break;
        case "Generate Code":
          promptText = `Generate code based on this description:\n\n${selectedText}`;
          break;
      }

      window.toast("Processing your request...", 2000);
      const response = await this.callAI(promptText, settings);
      if (response) {
        if (editorManager && editorManager.editor && editorManager.editor.session) {
          editorManager.editor.session.replace(editorManager.editor.getRange(), response);
        }
        window.toast(`${action} completed!`, 2000);
      }
    } catch (error) {
      console.error("Error in selection action:", error);
      window.toast("Error: " + (error && error.message ? error.message : error), 3000);
    }
  }

  switchView(view, app) {
    if (!app) return;
    this.currentView = view;

    const navBtns = app.querySelectorAll(".ai-nav-btn");
    navBtns.forEach((btn) => btn.classList.remove("active"));

    const chatArea = app.querySelector("#ai-chat-area");
    const historyArea = app.querySelector("#ai-history-area");
    const settingsArea = app.querySelector("#ai-settings-area");

    if (chatArea) chatArea.style.display = "none";
    if (historyArea) historyArea.style.display = "none";
    if (settingsArea) settingsArea.style.display = "none";

    switch (view) {
      case "chat":
        if (navBtns[0]) navBtns[0].classList.add("active");
        if (chatArea) chatArea.style.display = "flex";
        break;
      case "history":
        if (navBtns[1]) navBtns[1].classList.add("active");
        if (historyArea) {
          historyArea.style.display = "block";
          this.loadChatHistory(app).catch((e) => console.error(e));
        }
        break;
      case "settings":
        if (navBtns[2]) navBtns[2].classList.add("active");
        if (settingsArea) settingsArea.style.display = "block";
        break;
    }
  }

  async sendMessage(app) {
    if (!app) return;
    const inputField = app.querySelector(".ai-input");
    if (!inputField) return;
    const message = inputField.value.trim();

    if (!message || this.isGenerating) return;

    const chatArea = app.querySelector("#ai-chat-area");
    const welcomeMessage = chatArea && chatArea.querySelector(".ai-welcome-message");
    if (welcomeMessage) {
      welcomeMessage.remove();
    }

    this.addMessageToChat("user", message, app);
    inputField.value = "";

    this.isGenerating = true;
    const sendBtn = app.querySelector(".ai-send-btn");
    if (sendBtn) sendBtn.innerHTML = stopIconSvg;

    try {
      const settings = await this.getSettings();
      if (!settings.apiKey || !settings.baseUrl || !settings.model) {
        window.toast("Please configure API settings first", 3000);
        this.switchView("settings", app);
        return;
      }

      const aiMessageElement = this.addMessageToChat("assistant", "", app);
      let streamedText = "";

      try {
        const response = await this.callAI(message, settings, {
          onToken: (token) => {
            if (token == null) return;
            streamedText += token;
            aiMessageElement.innerHTML = this._escapeHtml(streamedText) + '<span class="ai-typing-cursor">|</span>';
            const chatAreaAfter = app.querySelector("#ai-chat-area");
            if (chatAreaAfter) {
              chatAreaAfter.scrollTop = chatAreaAfter.scrollHeight;
            }
          },
          onError: (err) => {
            const errText = err && err.message ? err.message : String(err);
            const safe = this._escapeHtml(errText).replace(/\n/g, "<br>");
            aiMessageElement.innerHTML = `<div class="ai-error">${safe}</div>`;
            if (aiMessageElement.parentElement) aiMessageElement.parentElement.classList.add("error");
            this.highlightCode(app);
          }
        });

        let finalResponse = response;
        if (typeof finalResponse !== "string") {
          finalResponse = String(finalResponse || "");
        }

        const isLikelyError = /rate limit|rate-limit|quota|429|error|timeout|exceeded/i.test(finalResponse);

        if (isLikelyError) {
          const safe = this._escapeHtml(finalResponse).replace(/\n/g, "<br>");
          aiMessageElement.innerHTML = `<div class="ai-error">${safe}</div>`;
          if (aiMessageElement.parentElement) aiMessageElement.parentElement.classList.add("error");
          this.highlightCode(app);
        } else {
          aiMessageElement.innerHTML = this.formatAIResponse(finalResponse);
          this.highlightCode(app);
        }

        const chatAreaAfter = app.querySelector("#ai-chat-area");
        if (chatAreaAfter) {
          requestAnimationFrame(() => {
            chatAreaAfter.scrollTop = chatAreaAfter.scrollHeight;
          });
        }

        if (!this.currentSession) {
          this.currentSession = {
            id: uuidv4(),
            messages: [],
          };
          this.sessions.push(this.currentSession);
        }

        this.currentSession.messages.push({ role: "user", content: message });
        this.currentSession.messages.push({ role: "assistant", content: finalResponse });

        this.saveSession().catch((e) => console.error("saveSession error:", e));
      } catch (aiError) {
        const errText = aiError && aiError.message ? aiError.message : String(aiError);
        const safe = this._escapeHtml(errText).replace(/\n/g, "<br>");
        aiMessageElement.innerHTML = `<div class="ai-error">${safe}</div>`;
        if (aiMessageElement.parentElement) aiMessageElement.parentElement.classList.add("error");
        this.highlightCode(app);
      }
    } catch (error) {
      console.error("Error generating response:", error);
      window.toast("Error generating response: " + (error && error.message ? error.message : error), 3000);
    } finally {
      this.isGenerating = false;
      if (sendBtn) sendBtn.innerHTML = sendIconSvg;
    }
  }

  addMessageToChat(role, content, app) {
    if (!app) return null;
    const chatArea = app.querySelector("#ai-chat-area");
    if (!chatArea) return null;

    const messageDiv = createTag("div", {
      className: `ai-message ${role}-message`,
    });

    const avatar = createTag("div", {
      className: "ai-avatar",
      innerHTML: role === "user" ? "👤" : "🤖",
    });

    const messageContent = createTag("div", {
      className: "ai-message-content",
      innerHTML: role === "assistant" ? content : (String(content).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")),
    });

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(messageContent);
    chatArea.appendChild(messageDiv);

    requestAnimationFrame(() => {
      chatArea.scrollTop = chatArea.scrollHeight;
    });

    return messageContent;
  }

  updateMessage(element, content, app) {
    if (!element) return;
    element.innerHTML = this.formatAIResponse(content);
    this.highlightCode(app);
  }

  formatAIResponse(content) {
    if (window.markdownit) {
      const md = window.markdownit();
      const highlight = function (str, lang) {
        if (lang && window.hljs) {
          try {
            return '<pre><code class="hljs">' + window.hljs.highlight(str, { language: lang }).value + '</code></pre>';
          } catch (__) {}
        }
        return '<pre><code>' + md.utils.escapeHtml(str) + '</code></pre>';
      };
      md.options.highlight = highlight;
      return md.render(content);
    }
    return String(content).replace(/\n/g, "<br>");
  }

  highlightCode(app) {
    if (!app) return;
    if (window.hljs) {
      app.querySelectorAll("pre code").forEach((block) => {
        try {
          window.hljs.highlightElement(block);
        } catch (e) {}
        const pre = block.closest("pre");
        if (!pre) return;
        if (pre.querySelector(".ai-copy-code-btn")) return;
        const btn = createTag("button", {
          className: "ai-copy-code-btn",
          innerHTML: copyIconSvg,
          title: "Copy code",
        });
        btn.onclick = this._createCopyHandler(block.innerText);
        pre.style.position = "relative";
        btn.style.position = "absolute";
        btn.style.right = "8px";
        btn.style.top = "8px";
        btn.style.zIndex = "20";
        pre.appendChild(btn);
      });
    }
  }

  _createCopyHandler(text) {
    return () => {
      copy(text);
      window.toast("Code copied to clipboard", 1200);
    };
  }

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async callAI(message, settings, handlers = {}) {
    const { apiKey, baseUrl, model } = settings;

    if (!apiKey || !baseUrl || !model) {
      throw new Error("Please configure API settings first");
    }

    const callbackManager = CallbackManager.fromHandlers({
      async handleLLMNewToken(token) {
        try {
          if (handlers && typeof handlers.onToken === "function") handlers.onToken(token);
        } catch (e) {}
      },
      async handleLLMError(err) {
        try {
          if (handlers && typeof handlers.onError === "function") handlers.onError(err);
        } catch (e) {}
      },
      async handleLLMEnd(output) {
        try {
          if (handlers && typeof handlers.onEnd === "function") handlers.onEnd(output);
        } catch (e) {}
      }
    });

    const chatModel = new ChatOpenAI({
      openAIApiKey: apiKey,
      modelName: model,
      configuration: {
        baseURL: baseUrl,
      },
      streaming: true,
      callbackManager,
    });

    const promptTemplate = ChatPromptTemplate.fromMessages([
      ["system", "You are a helpful assistant."],
      ["human", "{input}"],
    ]);

    const chain = promptTemplate.pipe(chatModel).pipe(new StringOutputParser());

    const response = await chain.invoke({ input: message });

    return response;
  }

  async getSettings() {
    let creds = null;
    if (this.apiKeyManager && typeof this.apiKeyManager.getCredentials === "function") {
      try {
        creds = await this.apiKeyManager.getCredentials("default");
      } catch (e) {
        creds = null;
      }
    }
    return {
      apiKey: (creds && creds.apiKey) || (localStorage.getItem("ai-api-key") || ""),
      baseUrl: (creds && creds.baseUrl) || (localStorage.getItem("ai-base-url") || "https://api.openai.com/v1"),
      model: (creds && creds.model) || (localStorage.getItem("ai-model") || "gpt-3.5-turbo"),
    };
  }

  async saveSettings(app) {
    if (!app) return;
    const settingsForm = app.querySelector(".ai-settings-form");
    if (!settingsForm) return;
    const apiKeyInput = settingsForm.querySelector("#api-key");
    const baseUrlInput = settingsForm.querySelector("#base-url");
    const modelInput = settingsForm.querySelector("#model-input");
    const apiKey = apiKeyInput ? apiKeyInput.value : "";
    const baseUrl = baseUrlInput ? baseUrlInput.value : "";
    const model = modelInput ? modelInput.value : "";

    if (apiKey && this.apiKeyManager && typeof this.apiKeyManager.saveAPIKey === "function") {
      try {
        await this.apiKeyManager.saveAPIKey("default", { apiKey, baseUrl, model });
      } catch (e) {
        console.error("saveAPIKey error:", e);
      }
    }

    if (baseUrl) localStorage.setItem("ai-base-url", baseUrl);
    if (model) localStorage.setItem("ai-model", model);

    window.toast("Settings saved successfully!", 2000);
  }

  async loadSettings(app) {
    if (!app) return;
    const settings = await this.getSettings();
    const settingsForm = app.querySelector(".ai-settings-form");
    if (!settingsForm) return;

    const baseUrlInput = settingsForm.querySelector("#base-url");
    const modelInput = settingsForm.querySelector("#model-input");
    const apiKeyInput = settingsForm.querySelector("#api-key");
    if (baseUrlInput) baseUrlInput.value = settings.baseUrl || "";
    if (modelInput) modelInput.value = settings.model || "";
    if (apiKeyInput) apiKeyInput.value = settings.apiKey || "";
  }

  async loadChatHistory(app) {
    if (!app) return;
    try {
      const historyList = app.querySelector(".ai-history-list");
      if (!historyList) return;
      historyList.innerHTML = "";
      const historyFiles = await fs.readdir(AI_HISTORY_PATH);
      for (const file of historyFiles) {
        if (file.endsWith(".json")) {
          try {
            const content = await fs.readFile(AI_HISTORY_PATH + "/" + file);
            const session = JSON.parse(content);
            const sessionItem = createTag("div", {
              className: "history-session-item",
            });
            sessionItem.onclick = this._createSessionClickHandler(session, app);
            const sessionTitle = createTag("div", {
              className: "session-title",
              textContent: `Session ${session.id ? session.id.substring(0, 8) + "..." : file}`,
            });
            const sessionDate = createTag("div", {
              className: "session-date",
              textContent: session.timestamp ? new Date(session.timestamp).toLocaleDateString() : "",
            });
            sessionItem.appendChild(sessionTitle);
            sessionItem.appendChild(sessionDate);
            historyList.appendChild(sessionItem);
          } catch (e) {
            console.error("Error parsing history file", file, e);
          }
        }
      }
    } catch (error) {
    }
  }

  _createSessionClickHandler(session, app) {
    return () => this.loadSession(session, app);
  }

  async loadSession(session, app) {
    if (!app || !session) return;
    this.currentSession = session;
    this.switchView("chat", app);
    const chatArea = app.querySelector("#ai-chat-area");
    if (!chatArea) return;
    chatArea.innerHTML = "";
    if (Array.isArray(session.messages)) {
      session.messages.forEach((msg) => {
        this.addMessageToChat(msg.role, msg.content, app);
      });
    }
  }

  async saveSession() {
    if (!this.currentSession) return;
    try {
      await fs.createDirectory(AI_HISTORY_PATH, true);
      this.currentSession.timestamp = Date.now();
      const sessionData = JSON.stringify(this.currentSession, null, 2);
      const filename = `${this.currentSession.id}.json`;
      await fs.writeFile(AI_HISTORY_PATH + "/" + filename, sessionData);
    } catch (error) {
      console.error("Error saving session:", error);
    }
  }

  onSidebarSelected(app) {
  }

  async destroy() {
    try {
      if (selectionMenu && typeof selectionMenu.remove === "function") {
        try {
          selectionMenu.remove("✨");
        } catch (e) {}
      }
    } catch (error) {}
    if (this.$githubDarkFile) this.$githubDarkFile.remove();
    if (this.$higlightJsFile) this.$higlightJsFile.remove();
    if (this.$markdownItFile) this.$markdownItFile.remove();
    if (this.$style) this.$style.remove();
  }
}

if (window.acode) {
  const acodePlugin = new AIAssistant();
  acode.setPluginInit(
    plugin.id,
    async (baseUrl, $page, options = {}) => {
      if (!baseUrl) baseUrl = "";
      if (!baseUrl.endsWith("/")) baseUrl += "/";
      acodePlugin.baseUrl = baseUrl;
      await acodePlugin.init($page, options.cacheFile, options.cacheFileUrl);
    }
  );
  acode.setPluginUnmount(plugin.id, () => {
    acodePlugin.destroy();
  });
}
