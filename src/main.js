import plugin from "../plugin.json";
import style from "./style.scss";

import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";

import copy from "copy-to-clipboard";
import { v4 as uuidv4 } from "uuid";
import { APIKeyManager } from "./api_key";
import { copyIconSvg, sendIconSvg, stopIconSvg } from "./constants";

const fs = acode.require("fs");
const select = acode.require("select");
const prompt = acode.require("prompt");
const DialogBox = acode.require("dialogBox");
const helpers = acode.require("helpers");
const loader = acode.require("loader");
const sidebarApps = acode.require("sidebarApps");
const toInternalUrl = acode.require("toInternalUrl");
const contextMenu = acode.require("contextMenu");
const selectionMenu = acode.require("selectionMenu");
const { editor } = editorManager;

const AI_HISTORY_PATH = window.DATA_STORAGE + "chatgpt";

let CURRENT_SESSION_FILEPATH = null;

class AIAssistant {
  async init($page, cacheFile, cacheFileUrl) {
    console.log("AIAssistant init called");
    console.log("sidebarApps available:", !!sidebarApps);
    console.log("selectionMenu available:", !!selectionMenu);

    this.$page = $page;
    this.cacheFile = cacheFile;
    this.cacheFileUrl = cacheFileUrl;

    this.$githubDarkFile = tag("link", {
      rel: "stylesheet",
      href: this.baseUrl + "assets/github-dark.css",
    });
    this.$higlightJsFile = tag("script", {
      src: this.baseUrl + "assets/highlight.min.js",
    });
    this.$markdownItFile = tag("script", {
      src: this.baseUrl + "assets/markdown-it.min.js",
    });
    this.$style = tag("style", {
      textContent: style,
    });

    document.head.append(
      this.$githubDarkFile,
      this.$higlightJsFile,
      this.$markdownItFile,
      this.$style
    );

    this.apiKeyManager = new APIKeyManager("acode-ai-assistant-secret");
    this.sessions = [];
    this.currentSession = null;
    this.currentView = "chat";
    this.isGenerating = false;

    try {
      this.setupSidebar();
      console.log("Sidebar setup completed");
    } catch (error) {
      console.error("Sidebar setup failed:", error);
    }

    try {
      this.setupSelectionMenu();
      console.log("Selection menu setup completed");
    } catch (error) {
      console.error("Selection menu setup failed:", error);
    }
  }

  setupSidebar() {
    console.log("Setting up sidebar...");
    console.log("baseUrl:", this.baseUrl);
    
    acode.addIcon("ai-assistant-icon", this.baseUrl + "icon.png");
    console.log("Icon added successfully");
    
    sidebarApps.add(
      "ai-assistant-icon",
      "ai-assistant-sidebar",
      "AI Assistant",
      (app) => {
        console.log("Initializing sidebar container");
        this.createSidebarContent(app);
      },
      false,
      (app) => {
        console.log("AI Assistant sidebar selected");
        this.onSidebarSelected(app);
      }
    );
    console.log("Sidebar app added successfully");
  }

  createSidebarContent(app) {
    console.log("Creating sidebar content directly in container");
    
    app.className = "ai-assistant-sidebar";
    
    const header = tag("div", {
      className: "ai-header"
    });

    const nav = tag("div", {
      className: "ai-nav"
    });

    const chatBtn = tag("button", {
      className: "ai-nav-btn active",
      textContent: "Chat",
      onclick: () => this.switchView("chat", app)
    });

    const historyBtn = tag("button", {
      className: "ai-nav-btn",
      textContent: "History",
      onclick: () => this.switchView("history", app)
    });

    const settingsBtn = tag("button", {
      className: "ai-nav-btn",
      textContent: "Settings",
      onclick: () => this.switchView("settings", app)
    });

    nav.appendChild(chatBtn);
    nav.appendChild(historyBtn);
    nav.appendChild(settingsBtn);
    header.appendChild(nav);

    const content = tag("div", {
      className: "ai-content scroll"
    });

    const chatArea = tag("div", {
      className: "ai-chat-area",
      id: "ai-chat-area"
    });

    const historyArea = tag("div", {
      className: "ai-history-area",
      id: "ai-history-area",
      style: { display: "none" }
    });

    const settingsArea = tag("div", {
      className: "ai-settings-area",
      id: "ai-settings-area",
      style: { display: "none" }
    });

    content.appendChild(chatArea);
    content.appendChild(historyArea);
    content.appendChild(settingsArea);

    const welcomeMessage = tag("div", {
      className: "ai-welcome-message",
      innerHTML: `
        <div class="ai-welcome-content">
          <h3>Welcome to AI Assistant</h3>
          <p>Start a conversation by typing your message below.</p>
        </div>
      `
    });
    chatArea.appendChild(welcomeMessage);

    const historyTitle = tag("h3", {
      textContent: "Chat History"
    });

    const historyList = tag("div", {
      className: "ai-history-list"
    });

    historyArea.appendChild(historyTitle);
    historyArea.appendChild(historyList);

    const settingsForm = tag("div", {
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
      `
    });

    settingsArea.appendChild(settingsForm);

    const saveBtn = settingsForm.querySelector(".save-settings-btn");
    saveBtn.onclick = () => this.saveSettings(app);
    this.loadSettings(app);

    const footer = tag("div", {
      className: "ai-footer"
    });

    const inputContainer = tag("div", {
      className: "ai-input-container"
    });

    const inputField = tag("textarea", {
      className: "ai-input",
      placeholder: "Type your message...",
      rows: 1,
      onkeydown: (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage(app);
        }
      }
    });

    const sendBtn = tag("button", {
      className: "ai-send-btn",
      innerHTML: sendIconSvg,
      onclick: () => this.sendMessage(app)
    });

    inputContainer.appendChild(inputField);
    inputContainer.appendChild(sendBtn);
    footer.appendChild(inputContainer);

    app.appendChild(header);
    app.appendChild(content);
    app.appendChild(footer);

    this.loadChatHistory(app);

    console.log("Sidebar content created and appended successfully");
  }

  setupSelectionMenu() {
    console.log("Setting up selection menu...");
    
    selectionMenu.add(async () => {
      console.log("Selection menu clicked");
      let opt = await select("AI Actions", ["Explain Code", "Rewrite", "Generate Code"], {
        onHide: () => { window.toast("Work is in progress...", 3000) }
      });
      console.log("Selected option:", opt);
      if (opt) {
        this.handleSelectionAction(opt);
      }
    }, "✨", "all");
    console.log("Selection menu added successfully");
  }

  async handleSelectionAction(action) {
    console.log("Handling selection action:", action);
    const selectedText = editor.getSelectedText();
    if (!selectedText) {
      window.toast("Please select some text first", 2000);
      return;
    }

    try {
      const settings = this.getSettings();
      if (!settings.apiKey || !settings.baseUrl || !settings.model) {
        window.toast("Please configure API settings first", 3000);
        return;
      }

      let promptText = "";
      switch(action) {
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
        editorManager.editor.session.replace(editor.getRange(), response);
        window.toast(`${action} completed!`, 2000);
      }
    } catch (error) {
      console.error("Error in selection action:", error);
      window.toast("Error: " + error.message, 3000);
    }
  }

  switchView(view, app) {
    console.log("Switching view to:", view);
    this.currentView = view;
    
    const navBtns = app.querySelectorAll(".ai-nav-btn");
    navBtns.forEach(btn => btn.classList.remove("active"));
    
    const chatArea = app.querySelector("#ai-chat-area");
    const historyArea = app.querySelector("#ai-history-area");
    const settingsArea = app.querySelector("#ai-settings-area");

    chatArea.style.display = "none";
    historyArea.style.display = "none";
    settingsArea.style.display = "none";

    switch(view) {
      case "chat":
        navBtns[0].classList.add("active");
        chatArea.style.display = "block";
        break;
      case "history":
        navBtns[1].classList.add("active");
        historyArea.style.display = "block";
        this.loadChatHistory(app);
        break;
      case "settings":
        navBtns[2].classList.add("active");
        settingsArea.style.display = "block";
        break;
    }
  }

  async sendMessage(app) {
    const inputField = app.querySelector(".ai-input");
    const message = inputField.value.trim();
    
    if (!message || this.isGenerating) return;

    const chatArea = app.querySelector("#ai-chat-area");
    const welcomeMessage = chatArea.querySelector(".ai-welcome-message");
    if (welcomeMessage) {
      welcomeMessage.remove();
    }

    this.addMessageToChat("user", message, app);
    inputField.value = "";

    this.isGenerating = true;
    const sendBtn = app.querySelector(".ai-send-btn");
    sendBtn.innerHTML = stopIconSvg;

    try {
      const settings = this.getSettings();
      if (!settings.apiKey || !settings.baseUrl || !settings.model) {
        window.toast("Please configure API settings first", 3000);
        this.switchView("settings", app);
        return;
      }

      const aiMessageElement = this.addMessageToChat("assistant", "", app);
      
      let response = await this.callAI(message, settings);
      
      this.updateMessage(aiMessageElement, response, app);
      
      if (!this.currentSession) {
        this.currentSession = {
          id: uuidv4(),
          messages: []
        };
        this.sessions.push(this.currentSession);
      }
      
      this.currentSession.messages.push({ role: "user", content: message });
      this.currentSession.messages.push({ role: "assistant", content: response });
      
      this.saveSession();
      
    } catch (error) {
      console.error("Error generating response:", error);
      window.toast("Error generating response: " + error.message, 3000);
    } finally {
      this.isGenerating = false;
      sendBtn.innerHTML = sendIconSvg;
    }
  }

  addMessageToChat(role, content, app) {
    const chatArea = app.querySelector("#ai-chat-area");
    
    const messageDiv = tag("div", {
      className: `ai-message ${role}-message`
    });

    const avatar = tag("div", {
      className: "ai-avatar",
      innerHTML: role === "user" ? "👤" : "🤖"
    });

    const messageContent = tag("div", {
      className: "ai-message-content",
      innerHTML: content
    });

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(messageContent);
    chatArea.appendChild(messageDiv);

    chatArea.scrollTop = chatArea.scrollHeight;

    return messageContent;
  }

  updateMessage(element, content, app) {
    element.innerHTML = this.formatAIResponse(content);
    this.highlightCode(app);
  }

  formatAIResponse(content) {
    if (window.markdownit) {
      const md = window.markdownit({
        highlight: function (str, lang) {
          if (lang && window.hljs) {
            try {
              return '<pre><code class="hljs">' + 
                     window.hljs.highlight(str, { language: lang }).value + 
                     '</code></pre>';
            } catch (__) {}
          }
          return '<pre><code>' + md.utils.escapeHtml(str) + '</code></pre>';
        }
      });
      return md.render(content);
    }
    return content.replace(/\n/g, '<br>');
  }

  highlightCode(app) {
    if (window.hljs) {
      app.querySelectorAll('pre code').forEach((block) => {
        window.hljs.highlightElement(block);
      });
    }
  }

  async callAI(message, settings) {
    const { apiKey, baseUrl, model } = settings;
    
    if (!apiKey || !baseUrl || !model) {
      throw new Error("Please configure API settings first");
    }
    
    const chatModel = new ChatOpenAI({
      openAIApiKey: apiKey,
      modelName: model,
      configuration: {
        baseURL: baseUrl,
      },
    });

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", "You are a helpful assistant."],
      ["human", "{input}"],
    ]);

    const chain = prompt.pipe(chatModel).pipe(new StringOutputParser());
    
    const response = await chain.invoke({ input: message });
    
    return response;
  }

  getSettings() {
    return {
      apiKey: localStorage.getItem("ai-api-key") || "",
      baseUrl: localStorage.getItem("ai-base-url") || "https://api.openai.com/v1",
      model: localStorage.getItem("ai-model") || "gpt-3.5-turbo"
    };
  }

  async saveSettings(app) {
    const settingsForm = app.querySelector(".ai-settings-form");
    const apiKey = settingsForm.querySelector("#api-key").value;
    const baseUrl = settingsForm.querySelector("#base-url").value;
    const model = settingsForm.querySelector("#model-input").value;

    if (apiKey) {
      await this.apiKeyManager.saveAPIKey("default", apiKey);
    }

    localStorage.setItem("ai-base-url", baseUrl);
    localStorage.setItem("ai-model", model);

    window.toast("Settings saved successfully!", 2000);
  }

  async loadSettings(app) {
    const settings = this.getSettings();
    const settingsForm = app.querySelector(".ai-settings-form");
    
    settingsForm.querySelector("#base-url").value = settings.baseUrl;
    settingsForm.querySelector("#model-input").value = settings.model;

    const apiKey = await this.apiKeyManager.getAPIKey("default");
    if (apiKey) {
      settingsForm.querySelector("#api-key").value = apiKey;
    }
  }

  async loadChatHistory(app) {
    try {
      const historyFiles = await fs.readdir(AI_HISTORY_PATH);
      const historyList = app.querySelector(".ai-history-list");
      historyList.innerHTML = "";

      for (const file of historyFiles) {
        if (file.endsWith('.json')) {
          const content = await fs.readFile(AI_HISTORY_PATH + '/' + file);
          const session = JSON.parse(content);
          
          const sessionItem = tag("div", {
            className: "history-session-item",
            onclick: () => this.loadSession(session, app)
          });

          const sessionTitle = tag("div", {
            className: "session-title",
            textContent: `Session ${session.id.substring(0, 8)}...`
          });

          const sessionDate = tag("div", {
            className: "session-date",
            textContent: new Date(session.timestamp).toLocaleDateString()
          });

          sessionItem.appendChild(sessionTitle);
          sessionItem.appendChild(sessionDate);
          historyList.appendChild(sessionItem);
        }
      }
    } catch (error) {
      console.log("No history found or error loading history:", error);
    }
  }

  async loadSession(session, app) {
    this.currentSession = session;
    this.switchView("chat", app);
    
    const chatArea = app.querySelector("#ai-chat-area");
    chatArea.innerHTML = "";

    session.messages.forEach(msg => {
      this.addMessageToChat(msg.role, msg.content, app);
    });
  }

  async saveSession() {
    if (!this.currentSession) return;

    try {
      await fs.createDirectory(AI_HISTORY_PATH, true);
      
      this.currentSession.timestamp = Date.now();
      const sessionData = JSON.stringify(this.currentSession, null, 2);
      const filename = `${this.currentSession.id}.json`;
      
      await fs.writeFile(AI_HISTORY_PATH + '/' + filename, sessionData);
    } catch (error) {
      console.error("Error saving session:", error);
    }
  }

  onSidebarSelected(app) {
    console.log("AI Assistant sidebar selected");
  }

  async destroy() {
    console.log("Destroying AI Assistant");
    try {
      // Fix: selectionMenu.remove() might not exist, use try-catch
      if (selectionMenu && typeof selectionMenu.remove === 'function') {
        selectionMenu.remove("✨");
      }
    } catch (error) {
      console.error("Error removing selection menu:", error);
    }
    
    if (this.$githubDarkFile) this.$githubDarkFile.remove();
    if (this.$higlightJsFile) this.$higlightJsFile.remove();
    if (this.$markdownItFile) this.$markdownItFile.remove();
    if (this.$style) this.$style.remove();
  }
}

if (window.acode) {
  console.log("Acode available, initializing AI Assistant plugin...");
  const acodePlugin = new AIAssistant();
  acode.setPluginInit(
    plugin.id,
    async (baseUrl, $page, { cacheFileUrl, cacheFile }) => {
      console.log("Plugin init callback called");
      if (!baseUrl.endsWith("/")) {
        baseUrl += "/";
      }
      acodePlugin.baseUrl = baseUrl;
      await acodePlugin.init($page, cacheFile, cacheFileUrl);
    },
  );
  acode.setPluginUnmount(plugin.id, () => {
    acodePlugin.destroy();
  });
}