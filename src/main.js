import plugin from "../plugin.json";
import style from "./style.scss";
import { HarmBlockThreshold, HarmCategory } from "@google/generative-ai";
import { ChatOllama } from "@langchain/community/chat_models/ollama";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { AIMessage, HumanMessage, trimMessages } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";

import copy from "copy-to-clipboard";
import { v4 as uuidv4 } from "uuid";
import { APIKeyManager } from "./api_key";
import { AI_PROVIDERS, OPENAI_LIKE, OPENROUTER, QWEN, copyIconSvg, sendIconSvg, stopIconSvg } from "./constants";
import { getModelsFromProvider } from "./utils";

const multiPrompt = acode.require("multiPrompt");
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
const terminal = acode.require("terminal");
const { editor } = editorManager;

const AI_HISTORY_PATH = window.DATA_STORAGE + "cli";

let CURRENT_SESSION_FILEPATH = null;

class AIAssistant {
  constructor() {
  // Initialize baseUrl for assets (critical for UI to work)
  this.baseUrl = window.DATA_STORAGE + plugin.id + "/";

  // Cache untuk responses
  this.responseCache = new Map();
  this.cacheTimeout = 30 * 60 * 1000; // 30 menit

  // File operations cache
  this.fileCache = new Map();
  this.projectStructure = null;
  this.lastStructureScan = null;

  // Real-time AI properties
  this.realTimeEnabled = false;
  this.realTimeDebounceTimer = null;
  this.realTimeDelay = 5000; // 5 detik delay for better token efficiency
  this.lastAnalyzedContent = "";
  this.currentSuggestions = [];
  this.suggestionWidget = null;
  this.errorMarkers = [];
  this.realTimeAnalysisCache = new Map();

  // Token usage tracking
  this.tokenUsage = {
    total: 0,
    today: 0,
    session: 0,
    lastReset: new Date().toDateString()
  };
  this.loadTokenUsage();
  this.updateTokenDisplay = this.updateTokenDisplay.bind(this);
}

  async init($page) {
    /**
     * Scripts and styles for Highlighting
     * and formating ai response
     */

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
    // Global styles
    this.$style = tag("style", {
      textContent: style,
    });
    document.head.append(
      this.$githubDarkFile,
      this.$higlightJsFile,
      this.$markdownItFile,
      this.$style,
    );

    /**
     * Adding command for starting cli assistant
     * And updating its token
     */

    editor.commands.addCommand({
      name: "ai_assistant",
      description: "Renz Ai",
      exec: this.run.bind(this),
    });

    selectionMenu.add(async () => {
      let opt = await select("AI Actions", [
        "Explain Code", 
        "Rewrite", 
        "Generate Code",
        "Run Current File",
        "Optimize Function",
        "Add Comments",
        "Generate Docs",
        "Edit with AI"
      ]);

      if (opt) {
        if (opt === "Run Current File") {
          await this.runCurrentFile();
        } else {
          const selectedText = editor.getSelectedText();
          if (selectedText) {
            await this.handleSelectionAction(opt, selectedText);
          } else {
            window.toast("Please select some code first", 3000);
          }
        }
      }
    }, "✨", 'all');

    $page.id = "acode-ai-assistant";
    $page.settitle("Renz Ai");
    this.$page = $page;
    const menuBtn = tag("span", {
      className: "icon more_vert",
      dataset: {
        action: "toggle-menu",
      },
    });

    const historyBtn = tag("span", {
      className: "icon historyrestore",
      dataset: {
        action: "history"
      }
    });

    // button for new chat
    const newChatBtn = tag("span", {
      className: "icon add",
      dataset: {
        action: "new-chat",
      },
    });

    const insertContextBtn = tag("span", {
      //className: "icon linkinsert_link",
      className: "icon insert_invitationevent",
      dataset: {
        action: "insert-context",
      },
    });
    insertContextBtn.onclick = async () => {
  const activeFile = editorManager.activeFile;
  if (activeFile) {
    const content = editor.getValue();
    const contextPrompt = `Current file: ${activeFile && activeFile.name ? activeFile.name : 'Unknown'}\n\nContent:\n\`\`\`\n${content || ''}\n\`\`\`\n\nHow can I help you with this code?`;

    if (!this.$page.isVisible) {
      await this.run();
    }

    this.$chatTextarea.value = contextPrompt;
    this.$chatTextarea.focus();
  } else {
    window.toast("No active file to insert context", 3000);
  }
};

    // Add token usage display (removed provider dropdown as requested)
    const tokenDisplay = this.createTokenDisplay();

    // Add search button
    const searchBtn = tag("span", {
      className: "icon",
      textContent: "🔍",
      title: "Search in chat"
    });
    searchBtn.onclick = () => this.searchInChat();

    this.$page.header.append(tokenDisplay, searchBtn, newChatBtn, insertContextBtn, historyBtn, menuBtn);

    historyBtn.onclick = this.myHistory.bind(this);
    newChatBtn.onclick = this.newChat.bind(this);

// AI Edit Current File
editor.commands.addCommand({
  name: "ai_edit_current_file",
  description: "Edit Current File with AI",
  bindKey: { win: "Ctrl-Shift-E", mac: "Cmd-Shift-E" },
  exec: () => this.showAiEditPopup()
});

// Explain Selected Code
editor.commands.addCommand({
  name: "ai_explain_code",
  description: "Explain Selected Code",
  bindKey: { win: "Ctrl-E", mac: "Cmd-E" },
  exec: () => {
    const selectedText = editor.getSelectedText();
    if (selectedText) {
      this.explainCodeWithChat(selectedText, editorManager.activeFile);
    } else {
      // Jika tidak ada selection, explain seluruh file
      const activeFile = editorManager.activeFile;
      if (activeFile) {
        const fullContent = editor.getValue();
        this.explainCodeWithChat(fullContent, activeFile);
      } else {
        window.toast("No code to explain", 3000);
      }
    }
  }
});

// Generate Code with AI
editor.commands.addCommand({
  name: "ai_generate_code",
  description: "Generate Code with AI",
  bindKey: { win: "Ctrl-Shift-G", mac: "Cmd-Shift-G" },
  exec: () => this.showGenerateCodePopup()
});

// Run Current File
editor.commands.addCommand({
  name: "ai_run_file",
  description: "Run Current File",
  bindKey: { win: "Ctrl-Shift-R", mac: "Cmd-Shift-R" },
  exec: () => this.runCurrentFile()
});

// Optimize Selected Function
editor.commands.addCommand({
  name: "ai_optimize_function",
  description: "Optimize Selected Function",
  bindKey: { win: "Ctrl-Shift-O", mac: "Cmd-Shift-O" },
  exec: () => {
    const selectedText = editor.getSelectedText();
    if (selectedText) {
      this.optimizeFunctionWithChat(selectedText);
    } else {
      window.toast("Please select function to optimize", 3000);
    }
  }
});

// Add Comments to Code
editor.commands.addCommand({
  name: "ai_add_comments",
  description: "Add Comments to Code",
  bindKey: { win: "Ctrl-Shift-C", mac: "Cmd-Shift-C" },
  exec: () => {
    const selectedText = editor.getSelectedText();
    if (selectedText) {
      this.addCommentsWithChat(selectedText);
    } else {
      window.toast("Please select code to add comments", 3000);
    }
  }
});

// Generate Documentation
editor.commands.addCommand({
  name: "ai_generate_docs",
  description: "Generate Documentation",
  bindKey: { win: "Ctrl-Shift-D", mac: "Cmd-Shift-D" },
  exec: () => {
    const selectedText = editor.getSelectedText();
    const activeFile = editorManager.activeFile;

    if (selectedText) {
      this.generateDocsWithChat(selectedText);
    } else if (activeFile) {
      // Generate docs untuk seluruh file
      this.generateDocsWithChat(null);
    } else {
      window.toast("No code to document", 3000);
    }
  }
});

// Rewrite Code
editor.commands.addCommand({
  name: "ai_rewrite_code",
  description: "Rewrite Selected Code",
  bindKey: { win: "Ctrl-Shift-R", mac: "Cmd-Shift-R" },
  exec: () => {
    const selectedText = editor.getSelectedText();
    if (selectedText) {
      this.rewriteCodeWithChat(selectedText);
    } else {
      window.toast("Please select code to rewrite", 3000);
    }
  }
});

    const contextMenuOption = {
      top: '35px',
      right: '10px',
      toggler: menuBtn,
      transformOrigin: 'top right',
    };
    const $menu = contextMenu({
    innerHTML: () => {
      return `
      <li action="model-provider" provider="">Provider: ${window.localStorage.getItem("ai-assistant-provider")}</li>
      <li action="model" modelNme="">Model: ${window.localStorage.getItem("ai-assistant-model-name")}</li>
      <li action="clear-cache">Clear Cache</li>
      <li action="clear-chat">Clear Chat History</li>
      <li action="export-chat">Export Conversation</li>
      <li action="copy-all">Copy All Messages</li>
      <li action="create-file-ai">Create File with AI</li>
      <li action="organize-project">Organize Project</li>
      <li action="bulk-operations">Bulk Operations</li>
      <li action="settings">Settings</li>
      `;
    },
    ...contextMenuOption
  })

    $menu.onclick = async (e) => {
      $menu.hide();
      const action = e.target.getAttribute('action');
      switch (action) {
        case 'model-provider':
          let previousProvider = window.localStorage.getItem("ai-assistant-provider");
          let providerSelectBox = await select("Select AI Provider", AI_PROVIDERS, {
            default: previousProvider || ""
          });
          if (previousProvider != providerSelectBox) {
            // Check for OpenAI-Like providers
            if (providerSelectBox === OPENAI_LIKE) {
              // Collect required information for OpenAI-Like providers
              const apiKey = await prompt("API Key", "", "text", { required: true });
              if (!apiKey) return;

              const baseUrl = await prompt("API Base URL", "https://api.openai.com/v1", "text", {
                required: true
              });

              const modelName = await prompt("Model", "", "text", { required: true });
              if (!modelName) return;

              // Save settings
              window.localStorage.setItem("ai-assistant-provider", OPENAI_LIKE);
              window.localStorage.setItem("ai-assistant-model-name", modelName);
              window.localStorage.setItem("openai-like-baseurl", baseUrl);

              await this.apiKeyManager.saveAPIKey(OPENAI_LIKE, apiKey);
              this.initiateModel(OPENAI_LIKE, apiKey, modelName);
              this.newChat();
            }
            // Handle other providers
            else {
              // check for api key
              if (window.localStorage.getItem(providerSelectBox) === null) {
                let apiKey =
                  providerSelectBox == AI_PROVIDERS[2]
                    ? "No Need Of API Key"
                    : await prompt("API key of selected provider", "", "text", {
                      required: true,
                    });
                if (!apiKey) return;
                loader.showTitleLoader();
                window.toast("Fetching available models from your account", 2000);
                let modelList = await getModelsFromProvider(providerSelectBox, apiKey);
                loader.removeTitleLoader();
                let modelNme = await select("Select AI Model", modelList);
                window.localStorage.setItem("ai-assistant-provider", providerSelectBox);
                window.localStorage.setItem("ai-assistant-model-name", modelNme);
                await this.apiKeyManager.saveAPIKey(providerSelectBox, apiKey);
                this.initiateModel(providerSelectBox, apiKey, modelNme);
                this.newChat();
              } else {
                let apiKey = await this.apiKeyManager.getAPIKey(providerSelectBox);
                this.initiateModel(providerSelectBox, apiKey, window.localStorage.getItem("ai-assistant-model-name"));
                this.newChat();
              }
            }
          }
          break;

      case 'clear-cache':
        this.clearCache();
        break;
      case 'create-file-ai':
        await this.createFileWithAI();
        break;
      case 'organize-project':
        await this.organizeProjectStructure();
        break;
      case 'bulk-operations':
        await this.bulkFileOperations();
        break;
      case 'clear-chat':
        await this.clearChatHistory();
        break;
      case 'export-chat':
        await this.exportConversation();
        break;
      case 'copy-all':
        await this.copyAllMessages();
        break;
      case 'settings':
        await this.showSettings();
        break;
case 'toggle-realtime':
  this.toggleRealTimeAI();
  break;


        case 'model':
          let provider = window.localStorage.getItem("ai-assistant-provider");
          let apiKey = await this.apiKeyManager.getAPIKey(provider);

          // Handle OpenAI-Like providers differently
          if (provider === OPENAI_LIKE) {
            let currentModel = window.localStorage.getItem("ai-assistant-model-name") || "";
            let modelName = await prompt("Enter Model", currentModel, "text", { required: true });
            if (modelName) {
              window.localStorage.setItem("ai-assistant-model-name", modelName);
              this.initiateModel(OPENAI_LIKE, apiKey, modelName);
            }
          } 
          // Handle other providers normally
          else {
            loader.showTitleLoader();
            window.toast("Fetching available models from your account", 2000);
            let modelList = await getModelsFromProvider(provider, apiKey);
            loader.removeTitleLoader();
            let modelNme = await select("Select AI Model", modelList, {
              default: window.localStorage.getItem("ai-assistant-model-name") || ""
            });
            if (window.localStorage.getItem("ai-assistant-model-name") != modelNme) {
              window.localStorage.setItem("ai-assistant-model-name", modelNme);
              this.initiateModel(provider, apiKey, modelNme);
            }
          }
          break;
      }
    };

    const mainApp = tag("div", {
      className: "mainApp",
    });
    // main chat box
    this.$chatBox = tag("div", {
      className: "chatBox",
    });
    // bottom query taker box
    this.$inputBox = tag("div", {
      className: "inputBox",
    });

    // Create UI elements in the correct order
    this.$chatTextarea = tag("textarea", {
      className: "chatTextarea",
      placeholder: "Type your query...",
    });

    this.$sendBtn = tag("button", {
      className: "sendBtn",
    });
    this.$sendBtn.innerHTML = sendIconSvg;

    this.$stopGenerationBtn = tag("button", {
      className: "stopGenerationBtn hide",
    });
    this.$stopGenerationBtn.innerHTML = stopIconSvg;
    this.$stopGenerationBtn.onclick = this.stopGenerating.bind(this);

    // Append elements in the correct order (fixed order to match main.js)
    this.$inputBox.append(this.$chatTextarea, this.$sendBtn, this.$stopGenerationBtn);
    mainApp.append(this.$inputBox, this.$chatBox);
    this.$page.append(mainApp);


    // Setup real-time AI features after UI elements are created
    this.setupRealTimeAI();

    // Add command palette control for AI
    this.setupCommandPaletteIntegration();

    // Add terminal command execution capability
    this.setupTerminalCommands();

    this.messageHistories = {};
    this.messageSessionConfig = {
      configurable: {
        sessionId: uuidv4(),
      },
    };
  }

  // Setup Command Palette Integration
  setupCommandPaletteIntegration() {
    // Add AI command to palette (tanpa override Ctrl+Shift+P)
    editor.commands.addCommand({
      name: "ai_command_palette",
      description: "AI Command Palette Control", 
      exec: () => this.showAiCommandPalette()
    });

    // Add AI chat command to palette
    editor.commands.addCommand({
      name: "ai_chat_command",
      description: "Execute Command via AI Chat",
      exec: () => this.executeCommandViaChat()
    });
  }

  async showAiCommandPalette() {
    try {
      // Get all available commands from Acode
      const availableCommands = this.getAvailableCommands();

      const userRequest = await prompt(
        "Ask AI to run a command (e.g., 'format code', 'toggle sidebar', 'open file')", 
        "", 
        "text", 
        { required: true }
      );

      if (!userRequest) return;

      // Let AI decide which command to run
      const aiPrompt = `Match "${userRequest}" to command:
${availableCommands.slice(0, 30).map(cmd => `${cmd.name}`).join(', ')}
Return exact name or "UNKNOWN":`;

      const response = await this.appendGptResponse(aiPrompt);
      const commandName = response.trim().replace(/[^a-zA-Z0-9_-]/g, '');

      if (commandName && commandName !== 'UNKNOWN') {
        // Execute the command
        const command = editor.commands.commands[commandName];
        if (command) {
          command.exec();
          window.toast(`✅ Executed: ${commandName}`, 3000);
        } else {
          window.toast(`❌ Command not found: ${commandName}`, 3000);
        }
      } else {
        window.toast("❌ Could not determine command from request", 3000);
      }

    } catch (error) {
      window.toast("❌ Error with command palette", 3000);
    }
  }

  getAvailableCommands() {
    // Get list of available commands from Acode editor
    const commands = editor.commands.commands;
    return Object.keys(commands).map(name => ({
      name: name,
      description: commands[name].description || ''
    }));
  }

  // Setup Terminal Command Execution
  setupTerminalCommands() {
    // Add terminal command execution capability
    editor.commands.addCommand({
      name: "ai_terminal_execute",
      description: "AI Terminal Command Execution",
      bindKey: { win: "Ctrl-Alt-T", mac: "Cmd-Alt-T" },
      exec: () => this.showAiTerminal()
    });
  }

  async showAiTerminal() {
    try {
      const userCommand = await prompt(
        "Enter terminal command or describe what you want to do:", 
        "", 
        "text", 
        { required: true }
      );

      if (!userCommand) return;

      // Check if it's a direct command or needs AI interpretation
      if (userCommand.includes(' ') && !userCommand.startsWith('/') && !userCommand.includes('&&')) {
        // Looks like natural language, let AI convert it
        const aiPrompt = `Convert "${userCommand}" to safe terminal command.
Rules: No rm/delete. Dev tasks only.
Examples: "list files"→"ls -la", "show dir"→"pwd"
Command:`;

        const response = await this.appendGptResponse(aiPrompt);
        const safeCommand = response.trim().replace(/[;&|`$()]/g, ''); // Basic safety filtering

        if (safeCommand && !safeCommand.includes('rm ') && !safeCommand.includes('delete')) {
          this.executeTerminalCommand(safeCommand);
        } else {
          window.toast("❌ Command not safe or unclear", 3000);
        }
      } else {
        // Direct command execution
        this.executeTerminalCommand(userCommand);
      }

    } catch (error) {
      window.toast("❌ Error with terminal execution", 3000);
    }
  }

  async executeTerminalCommand(command) {
    try {
      const confirmation = await prompt(
        `Execute: ${command}?`, 
        "", 
        "text", 
        { required: false }
      );

      if (confirmation !== null) {
        // Use Acode terminal API properly
        const activeFile = editorManager.activeFile;
        const workingDir = activeFile?.uri ? activeFile.uri.split('/').slice(0, -1).join('/') : '/';
        
        const term = await terminal.create({
          name: 'AI Terminal',
          serverMode: true
        });

        if (term && term.id) {
          // Write command with proper line ending to execute it
          terminal.write(term.id, command + '\r\n');
          window.toast(`🚀 Executing: ${command}`, 3000);
          this.appendSystemMessage(`Terminal: ${command}`);
        } else {
          window.toast("❌ Cannot create terminal", 3000);
        }
      }

    } catch (error) {
      window.toast("❌ Terminal execution failed", 3000);
    }
  }

  async executeCommandViaChat() {
    try {
      // Show AI assistant if not visible
      if (!this.$page || !this.$page.isVisible) {
        await this.run();
      }

      // Add system message to show available commands
      const availableCommands = this.getAvailableCommands();
      const commandList = availableCommands.slice(0, 20).map(cmd => `• ${cmd.name}`).join('\n');

      this.appendSystemMessage(`Available Commands:\n${commandList}\n\nType: "run command [name]" or describe what you want to do`);

      // Focus on chat input
      if (this.$chatTextarea) {
        this.$chatTextarea.focus();
      }

    } catch (error) {
      window.toast("❌ Error opening AI chat", 3000);
    }
  }

  async executeCommandFromChat(commandRequest) {
    try {
      const availableCommands = this.getAvailableCommands();

      // Let AI decide which command to run
      const aiPrompt = `Find command for "${commandRequest}":
${availableCommands.slice(0, 25).map(cmd => cmd.name).join(', ')}
Exact name:`;

      // Show processing message
      this.appendSystemMessage(`🔄 Processing command: "${commandRequest}"`);

      const response = await this.appendGptResponse(aiPrompt);
      const commandName = response.trim().replace(/[^a-zA-Z0-9_-]/g, '');

      if (commandName && commandName !== 'UNKNOWN') {
        // Execute the command
        const command = editor.commands.commands[commandName];
        if (command) {
          command.exec();
          this.appendSystemMessage(`✅ Executed command: ${commandName}`);
        } else {
          this.appendSystemMessage(`❌ Command not found: ${commandName}`);
        }
      } else {
        this.appendSystemMessage(`❌ Could not determine command from request: "${commandRequest}"`);
      }

    } catch (error) {
      this.appendSystemMessage(`❌ Error processing command: ${error.message}`);
    }
  }

  appendSystemMessage(message) {
    if (this.$chatBox) {
      const systemMsg = tag("div", {
        className: "system_message",
        style: `
          background: var(--galaxy-void);
          color: var(--galaxy-star-green);
          padding: 8px 16px;
          margin: 8px 0;
          border-left: 3px solid var(--galaxy-star-green);
          border-radius: 8px;
          font-family: monospace;
          font-size: 14px;
          white-space: pre-line;
        `,
        textContent: message
      });

      this.$chatBox.appendChild(systemMsg);
      this.scrollToBottom();
    }
  }

  async run() {
    try {

      // Authentication and API key handling
      let passPhrase;
      if (await fs(window.DATA_STORAGE + "secret.key").exists()) {
        passPhrase = await fs(window.DATA_STORAGE + "secret.key").readFile(
          "utf-8",
        );
      } else {
        let secretPassphrase = await prompt(
          "Enter a secret pass phrase to save the API key",
          "",
          "text",
          {
            required: true,
          },
        );
        if (!secretPassphrase) return;
        passPhrase = secretPassphrase;
      }

      this.apiKeyManager = new APIKeyManager(passPhrase);
      let token;
      let providerNme = window.localStorage.getItem("ai-assistant-provider");

      if (providerNme) {
        token = await this.apiKeyManager.getAPIKey(providerNme);
      } else {
        let modelProvider = await select("Select AI Provider", AI_PROVIDERS);

        // Handle OpenAI-Like providers
        if (modelProvider === OPENAI_LIKE) {
          // Prompt for required information
          const apiKey = await prompt("API Key", "", "password", { required: true });
          if (!apiKey) return;

          const baseUrl = await prompt("API Base URL", "https://api.openai.com/v1", "text", {
            required: true
          });

          const modelName = await prompt("Model", "", "text", { required: true });
          if (!modelName) return;

          // Save settings
          window.localStorage.setItem("ai-assistant-provider", OPENAI_LIKE);
          window.localStorage.setItem("ai-assistant-model-name", modelName);
          window.localStorage.setItem("openai-like-baseurl", baseUrl);

          token = apiKey;
          providerNme = OPENAI_LIKE;
          await fs(window.DATA_STORAGE).createFile("secret.key", passPhrase);
          await this.apiKeyManager.saveAPIKey(OPENAI_LIKE, token);
          window.toast("Configuration saved 👄", 3000);
        } 
        // Handle other providers
        else {
          // No prompt for API key in case of Ollama
          let apiKey =
            modelProvider == AI_PROVIDERS[2]
              ? "No Need Of API Key"
              : await prompt("API key of selected provider", "", "password", {
                required: true,
              });
          if (!apiKey) return;

          loader.showTitleLoader();
          window.toast("Fetching available models from your account", 2000);
          let modelList = await getModelsFromProvider(modelProvider, apiKey);
          loader.removeTitleLoader();

          const modelNme = await select("Select AI Model", modelList);
          if (!modelNme) return;

          window.localStorage.setItem("ai-assistant-provider", modelProvider);
          window.localStorage.setItem("ai-assistant-model-name", modelNme);
          providerNme = modelProvider;
          token = apiKey;
          await fs(window.DATA_STORAGE).createFile("secret.key", passPhrase);
          await this.apiKeyManager.saveAPIKey(providerNme, token);
          window.toast("Configuration saved👄", 3000);
        }
      }

      let model = window.localStorage.getItem("ai-assistant-model-name");

      this.initiateModel(providerNme, token, model)
      this.initializeMarkdown();

      this.$sendBtn.addEventListener("click", this.sendQuery.bind(this));

      // Add keyboard shortcut for sending messages
      this.$chatTextarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.sendQuery();
        }
      });

      // Show the page
      this.$page.show();

      // Focus on the textarea
      setTimeout(() => {
        this.$chatTextarea.focus();
      }, 300);

    } catch (e) {
      window.toast("Error in run method", 3000);
      window.toast("Error initializing Renz Ai: " + e.message, 5000);
    }
  }

  initiateModel(providerNme, token, model) {
    switch (providerNme) {
      case AI_PROVIDERS[0]: // OpenAI
        this.modelInstance = new ChatOpenAI({ apiKey: token, model });
        break;
      case AI_PROVIDERS[1]: // Google
        this.modelInstance = new ChatGoogleGenerativeAI({
          model,
          apiKey: token,
          safetySettings: [
            {
              category: HarmCategory.HARM_CATEGORY_HARASSMENT,
              threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
            },
          ],
        });
        break;
      case AI_PROVIDERS[2]: // Ollama
        // check local storage, if user want to provide custom host for ollama
        let baseUrl = window.localStorage.getItem("Ollama-Host")
          ? window.localStorage.getItem("Ollama-Host")
          : "http://localhost:11434";
        this.modelInstance = new ChatOllama({
          baseUrl,
          model
        });
        break;
      case AI_PROVIDERS[3]: // Groq
        this.modelInstance = new ChatGroq({
          apiKey: token,
          model,
        });
        break;
      case AI_PROVIDERS[4]: // OpenRouter
        this.modelInstance = new ChatOpenAI({
          apiKey: token,
          model,
          configuration: {
            baseURL: "https://openrouter.ai/api/v1",
            defaultHeaders: {
              "HTTP-Referer": "https://acode.foxdebug.com",
              "X-Title": "Renz Ai Cli"
            }
          }
        });
        break;
      case AI_PROVIDERS[5]: // Qwen
        this.modelInstance = new ChatOpenAI({
          apiKey: token,
          model,
          configuration: {
            baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
          }
        });
        break;
      case OPENAI_LIKE: // OpenAI-Like providers
        const customBaseUrl = window.localStorage.getItem("openai-like-baseurl") || "https://api.openai.com/v1";
        this.modelInstance = new ChatOpenAI({
          apiKey: token,
          model,
          configuration: {
            baseURL: customBaseUrl
          }
        });
        break;
      default:
        throw new Error("Unknown provider");
    }
  }

  _sanitizeFileName(fileName) {
    /*
    Enhanced utility function for removing special characters and
    making filename safe for all operating systems
    */
    if (!fileName || typeof fileName !== 'string') {
      return 'untitled_file';
    }

    // Remove dangerous characters and symbols
    const sanitizedFileName = fileName
      .replace(/[^\w\s.-]/gi, "")  // Keep only word chars, spaces, dots, hyphens
      .replace(/\.\.+/g, ".")     // Replace multiple dots with single dot
      .replace(/^\.|\.$/, "");    // Remove leading/trailing dots

    // Trim leading and trailing spaces
    const trimmedFileName = sanitizedFileName.trim();

    // Replace spaces and multiple underscores with single underscore
    const finalFileName = trimmedFileName
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/, "");  // Remove leading/trailing underscores

    // Ensure we have a valid filename
    return finalFileName.length > 0 ? finalFileName : 'untitled_file';
  }

  transformMessages(messages) {
    const result = messages
      .map((message, index) => {
        // Assuming every even-indexed element (0, 2, 4,...) is a human message
        // and the subsequent odd-indexed element (1, 3, 5,...) is its corresponding AI message
        if (index % 2 === 0 && index + 1 < messages.length) {
          return {
            prompt: messages[index].content,
            result: messages[index + 1].content,
          };
        } else {
          return null; // Handle uneven or incomplete pairs if necessary
        }
      })
      .filter((pair) => pair !== null && pair !== undefined);

    return result;
  }

  async saveHistory() {
    /*
    save chat history
    */
    try {
      let sessionId = this.messageSessionConfig.configurable.sessionId;
      if (!this.messageHistories[sessionId].messages.length) {
        return;
      }

      if (CURRENT_SESSION_FILEPATH == null) {
        try {
          const sanitisedFileNme = this._sanitizeFileName(
            this.messageHistories[sessionId].messages[0].content.substring(
              0,
              30,
            ),
          );
          const uniqueName = `${sanitisedFileNme}__${sessionId}.json`;

          if (!(await fs(AI_HISTORY_PATH).exists())) {
            await fs(window.DATA_STORAGE).createDirectory("cli");
          }
          let messages = await this.messageHistories[sessionId].getMessages();
          const history = this.transformMessages(messages);
          CURRENT_SESSION_FILEPATH = await fs(AI_HISTORY_PATH).createFile(
            uniqueName,
            history,
          );
        } catch (err) {
          alert(err.message);
        }
      } else {
        try {
          if (!(await fs(CURRENT_SESSION_FILEPATH).exists())) {
            this.newChat();
            window.toast(
              "Some error occurred or file you trying to open has been deleted",
            );
            return;
          }

          let messages = await this.messageHistories[sessionId].getMessages();

          CURRENT_SESSION_FILEPATH = await fs(
            CURRENT_SESSION_FILEPATH,
          ).writeFile(this.transformMessages(messages));
        } catch (err) {
          alert(err.message);
        }
      }
    } catch (err) {
      window.alert(err.message);
    }
  }

  newChat() {
    /*
    Start new chat session
    */
    this.$chatBox.innerHTML = "";
    window.toast("New session", 3000);
    this.messageHistories = {};
    this.messageSessionConfig = {
      configurable: {
        sessionId: uuidv4(),
      },
    };
    CURRENT_SESSION_FILEPATH = null;
  }

  async getHistoryItems() {
    /*
    get list of history items
    */
    if (await fs(AI_HISTORY_PATH).exists()) {
      const allFiles = await fs(AI_HISTORY_PATH).lsDir();
      let elems = "";
      for (let i = 0; i < allFiles.length; i++) {
        elems += `<li class="dialog-item" style="background: var(--secondary-color);color: var(--secondary-text-color);padding: 5px;margin-bottom: 5px;border-radius: 8px;font-size:15px;display:flex;flex-direction:row;justify-content:space-between;gap:5px;" data-path="${JSON.parse(JSON.stringify(allFiles[i])).url
          }">
                  <p class="history-item">${allFiles[i].name
            .split("__")[0]
            .substring(
              0,
              25,
            )}...</p><div><button class="delete-history-btn" style="height:25px;width:25px;border:none;padding:5px;outline:none;border-radius:50%;background:var(--error-text-color);text-align:center;">âœ—</button></div>
                </li>`;
      }
      return elems;
    } else {
      let elems = "";
      elems = `<li style="background: var(--secondary-color);color: var(--secondary-text-color);padding: 10px;border-radius: 8px;" data-path="#not-available">Not Available</li>`;
      return elems;
    }
  }

  extractUUID(str) {
    // the regex pattern for the UUID
    const uuidPattern =
      /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
    // Use the pattern to match the string
    const match = str.match(uuidPattern);
    // If a match is found, return it; otherwise, return null
    return match ? match[0] : null;
  }

  async displayHistory(url, historyDialogBox) {
    /*
    display selected chat history
    */
    this.$chatBox.innerHTML = "";
    const fileUrl = url.slice(1, url.length - 1);
    const sessionId = this.extractUUID(fileUrl);

    if (!sessionId) {
      this.newChat();
      window.toast("Some error occurred");
      return;
    }
    if (!(await fs(fileUrl).exists())) {
      this.newChat();
      window.toast(
        "Some error occurred or file you trying to open has been deleted",
      );
      return;
    }

    CURRENT_SESSION_FILEPATH = fileUrl;
    try {
      historyDialogBox.hide();
      loader.create("Wait", "Fetching chat history....");
      const fileData = await fs(fileUrl).readFile();
      const responses = JSON.parse(await helpers.decodeText(fileData));
      this.messageHistories = {};
      this.messageHistories[sessionId] = new InMemoryChatMessageHistory();
      let messages = responses.flatMap((pair) => [
        new HumanMessage({ content: pair.prompt }),
        new AIMessage({ content: pair.result }),
      ]);
      await this.messageHistories[sessionId].addMessages(messages);
      this.messageSessionConfig = {
        configurable: {
          sessionId,
        },
      };

      responses.forEach((e) => {
        this.appendUserQuery(e.prompt);
        this.appendGptResponse(e.result);
      });
      loader.destroy();
    } catch (err) {
      loader.destroy();
      window.toast("Error loading chat history", 3000);
    }
  }

  async myHistory() {
    /*
    show conversation history
    */
    try {
      const historyList = await this.getHistoryItems();
      const content = `<ul>${historyList}</ul>`;
      const historyDialogBox = DialogBox(
        "Conversation History",
        content,
        "Cancel",
      );

      historyDialogBox.onclick(async (e) => {
        const dialogItem = e.target.closest(".dialog-item");
        const deleteButton = dialogItem.querySelector(".delete-history-btn");
        const historyItem = dialogItem.querySelector(".history-item");
        if (dialogItem.getAttribute("data-path") == "#not-available") {
          return;
        }
        if (!dialogItem.getAttribute("data-path")) {
          return;
        }
        if (e.target === dialogItem || e.target === historyItem) {
          const fileUrl = JSON.stringify(dialogItem.getAttribute("data-path"));
          this.displayHistory(fileUrl, historyDialogBox);
        } else if (e.target === deleteButton) {
          const fileUrl = JSON.stringify(dialogItem.getAttribute("data-path"));
          const url = fileUrl.slice(1, fileUrl.length - 1);

          await fs(dialogItem.getAttribute("data-path")).delete();
          //alert(CURRENT_SESSION_FILEPATH);

          if (CURRENT_SESSION_FILEPATH == url) {
            const chatBox = document.querySelector(".chatBox");
            chatBox.innerHTML = "";
            this.messageHistories = {};
            this.messageSessionConfig = {
              configurable: {
                sessionId: uuidv4(),
              },
            };
          }

          dialogItem.remove();
          window.toast("Deleted", 3000);
          CURRENT_SESSION_FILEPATH = null;
        }
      });
    } catch (err) {
      window.alert(err.message);
    }
  }

  async sendQuery() {
    /*
    event on clicking send prompt button of chatgpt
    */
    const chatText = this.$chatTextarea;
    if (chatText.value != "") {
      // Switch button states immediately
      this.$sendBtn.classList.add("hide");
      this.$stopGenerationBtn.classList.remove("hide");

      this.appendUserQuery(chatText.value);
      this.scrollToBottom();
      this.appendGptResponse("");
      this.loader();

      // Store query for potential stop operation
      this.currentQuery = chatText.value;

      try {
        await this.getCliResponse(chatText.value);
      } catch (error) {
        // Handle errors and reset buttons
        this.showError(error);
        this.$stopGenerationBtn.classList.add("hide");
        this.$sendBtn.classList.remove("hide");
        clearInterval(this.$loadInterval);
      }

      chatText.value = "";
    }
  }

  async appendUserQuery(message) {
    /*
    add user query to ui with markdown support
    */
    try {
      const userAvatar = this.baseUrl + "assets/user_avatar.png";
      const userChatBox = tag("div", { className: "wrapper" });
      const chat = tag("div", { className: "chat" });
      const profileImg = tag("div", {
        className: "profile",
        child: tag("img", {
          src: userAvatar,
          alt: "user",
        }),
      });
      const msg = tag("div", {
        className: "message user_message",
      });

      // Add markdown support for user messages like AI messages
      if (this.$mdIt && typeof this.$mdIt.render === 'function') {
        try {
          const renderedHtml = this.$mdIt.render(message);
          msg.innerHTML = renderedHtml;

          // Apply syntax highlighting to user messages too
          msg.querySelectorAll('pre code').forEach((block) => {
            if (window.hljs && window.hljs.highlightElement) {
              window.hljs.highlightElement(block);
            }
          });
        } catch (err) {
          // Fallback to plain text if markdown fails
          msg.textContent = message;
        }
      } else {
        msg.textContent = message;
      }

      chat.append(...[profileImg, msg]);
      userChatBox.append(chat);
      this.$chatBox.appendChild(userChatBox);
    } catch (err) {
      window.toast("Error displaying user message", 3000);
    }
  }

  async appendGptResponse(message) {  
  try {  
    // Track token usage for response - estimate tokens if not provided    
    const estimatedTokens = Math.ceil(message.length / 4);    
    this.updateTokenUsage(estimatedTokens);
    
    // Initialize markdown-it if not already initialized  
    if (!this.$mdIt && window.markdownit) {  
      this.$mdIt = window.markdownit({  
        html: false,  
        xhtmlOut: false,  
        breaks: true, // Enable line breaks  
        linkify: true, // Enable auto-linking  
        typographer: true,  
        quotes: '""\'\'',  
        highlight: function (str, lang) {  
          const copyBtn = document.createElement("button");  
          copyBtn.classList.add("copy-button");  
          copyBtn.innerHTML = copyIconSvg;  
          copyBtn.setAttribute("data-str", str);  
          const codesArea = `<pre class="hljs codesArea"><code>${window.hljs ? window.hljs.highlightAuto(str).value : str}</code></pre>`;  
          const codeBlock = `<div class="codeBlock">${copyBtn.outerHTML}${codesArea}</div>`;  
          return codeBlock;  
        },  
      });  
    }  
  
    const ai_avatar = this.baseUrl + "assets/ai_assistant.svg";  
    const gptChatBox = tag("div", { className: "ai_wrapper" });  
    const chat = tag("div", { className: "ai_chat" });  
    const profileImg = tag("div", {  
      className: "ai_profile",  
      child: tag("img", {  
        src: ai_avatar,  
        alt: "ai",  
      }),  
    });  
    const msg = tag("div", {  
      className: "ai_message",  
    });  
  
    // Enhanced markdown rendering with better formatting  
    if (this.$mdIt && typeof this.$mdIt.render === 'function') {  
      try {  
        // Enhanced pre-processing with no sanitization for full markdown support  
        let processedMessage = message; // Use raw message for full markdown rendering  
  
        // Full markdown rendering without pre-processing interference  
        const renderedHtml = this.$mdIt.render(processedMessage);  
        msg.innerHTML = renderedHtml;  
  
        // Apply syntax highlighting to all code blocks  
        msg.querySelectorAll('pre code').forEach((block) => {  
          if (window.hljs && window.hljs.highlightElement) {  
            window.hljs.highlightElement(block);  
          }  
        });  
  
        // Enhanced styling for better readability  
        msg.style.cssText = `  
          line-height: 1.6;  
          font-size: 14px;  
          color: var(--primary-text-color);  
          padding: 8px 12px;  
          word-wrap: break-word;  
          white-space: pre-wrap;  
        `;  
  
        // Add event listeners to copy buttons with improved feedback  
        setTimeout(() => {  
          const copyBtns = msg.querySelectorAll(".copy-button");  
          if (copyBtns && copyBtns.length > 0) {  
            for (const copyBtn of copyBtns) {  
              copyBtn.addEventListener("click", function () {  
                try {  
                  copy(this.dataset.str);  
                  this.innerHTML = '✓';  
                  window.toast("Code copied to clipboard!", 2000);  
                  setTimeout(() => {  
                    this.innerHTML = copyIconSvg;  
                  }, 1500);  
                } catch (err) {  
                  window.toast("Failed to copy", 2000);  
                }  
              });  
            }  
          }  
        }, 100);  
  
      } catch (renderError) {  
        window.toast("Markdown render error", 3000);  
        // Fallback with styled plain text  
        msg.textContent = message;  
        msg.style.cssText = `  
          line-height: 1.6;  
          font-size: 14px;  
          color: var(--primary-text-color);  
          padding: 8px 12px;  
          word-wrap: break-word;  
          white-space: pre-wrap;  
        `;  
      }  
    } else {  
      // Enhanced fallback with better styling  
      msg.textContent = message;  
      msg.style.cssText = `  
        line-height: 1.6;  
        font-size: 14px;  
        color: var(--primary-text-color);  
        padding: 8px 12px;  
        word-wrap: break-word;  
        white-space: pre-wrap;  
      `;  
      window.toast("Markdown renderer not available", 2000);  
    }  
  
    chat.append(...[profileImg, msg]);  
    gptChatBox.append(chat);  
    this.$chatBox.appendChild(gptChatBox);  
  } catch (err) {  
    window.toast("Error displaying AI response", 3000);  
  }  
}


  showError(error) {
    // Show detailed error information
    const responseBoxes = Array.from(document.querySelectorAll(".ai_message"));
    if (responseBoxes.length > 0) {
      const lastResponse = responseBoxes[responseBoxes.length - 1];

      let errorMessage = "❌ Error occurred";
      if (error && error.message) {
        if (error.message.includes('429')) {
          errorMessage = "❌ API Rate limit exceeded. Please wait and try again.";
        } else if (error.message.includes('401')) {
          errorMessage = "❌ Invalid API key. Please check your API key settings.";
        } else if (error.message.includes('network') || error.message.includes('fetch')) {
          errorMessage = "❌ Network error. Please check your internet connection.";
        } else if (error.message.includes('timeout')) {
          errorMessage = "❌ Request timeout. Please try again.";
        } else {
          errorMessage = `❌ Error: ${error.message}`;
        }
      }

      lastResponse.innerHTML = `<div style="color: #ff6b6b; padding: 12px; background: rgba(255,107,107,0.1); border-radius: 8px; border-left: 3px solid #ff6b6b;">${errorMessage}</div>`;
    }

    window.toast(errorMessage, 4000);
  }

  async stopGenerating() {
    // Stop generation and reset UI
    if (this.abortController) {
      this.abortController.abort();
    }

    // Clear loading interval
    if (this.$loadInterval) {
      clearInterval(this.$loadInterval);
    }

    // Reset buttons
    this.$stopGenerationBtn.classList.add("hide");
    this.$sendBtn.classList.remove("hide");

    // Show stopped message in last AI response
    const responseBoxes = Array.from(document.querySelectorAll(".ai_message"));
    if (responseBoxes.length > 0) {
      const lastResponse = responseBoxes[responseBoxes.length - 1];
      if (lastResponse.textContent.trim() === '' || lastResponse.innerHTML.includes('😖')) {
        lastResponse.innerHTML = '<em style="color: #ff6b6b;">Response stopped by user</em>';
      }
    }

    window.toast("⏹️ Generation stopped", 2000);
  }

  async getCliResponse(question) {
  try {
    // Make sure we have response boxes
    const responseBoxes = Array.from(document.querySelectorAll(".ai_message"));
    if (responseBoxes.length === 0) {
      window.toast("No response box found", 3000);
      // Create a response box if none exists
      this.appendGptResponse("");
      // Try again with the newly created box
      setTimeout(() => this.getCliResponse(question), 100);
      return;
    }

    const targetElem = responseBoxes[responseBoxes.length - 1];
    if (!targetElem) {
      window.toast("Target element not found", 3000);
      return;
    }

    // Check cache first
    const cachedResponse = this.getCachedResponse(question);
    if (cachedResponse) {
      clearInterval(this.$loadInterval);
      this.$sendBtn.classList.add("hide");
      this.$stopGenerationBtn.classList.remove('hide');

      // Simulate streaming for cached response
      targetElem.innerHTML = "";
      let index = 0;
      const streamCache = () => {
        if (index < cachedResponse.length) {
          targetElem.textContent += cachedResponse[index];
          index++;
          this.scrollToBottom();
          setTimeout(streamCache, 10);
        } else {
          // Ensure markdown renderer is available
          if (this.$mdIt && typeof this.$mdIt.render === 'function') {
            const renderedHtml = this.$mdIt.render(cachedResponse);
            targetElem.innerHTML = renderedHtml;

            // Apply syntax highlighting to cached responses
            targetElem.querySelectorAll('pre code').forEach((block) => {
              if (window.hljs && window.hljs.highlightElement) {
                window.hljs.highlightElement(block);
              }
            });

            // Enhanced copy button functionality with visual feedback
            setTimeout(() => {
              const copyBtns = targetElem.querySelectorAll(".copy-button");
              if (copyBtns && copyBtns.length > 0) {
                for (const copyBtn of copyBtns) {
                  copyBtn.addEventListener("click", function () {
                    copy(this.dataset.str);
                    // Enhanced visual feedback
                    this.style.background = 'linear-gradient(45deg, #4CAF50, #45a049)';
                    this.textContent = '✓ Copied!';
                    setTimeout(() => {
                      this.style.background = '';
                      this.textContent = 'Copy';
                    }, 2000);
                    window.toast("📋 Copied to clipboard", 3000);
                  });
                }
              }
            }, 100);
          } else {
            targetElem.textContent = cachedResponse;
          }

          this.$stopGenerationBtn.classList.add("hide");
          this.$sendBtn.classList.remove("hide");
          window.toast("Response from cache", 1500);
        }
      };
      streamCache();
      return;
    }

    // Original AI request code
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    // Get current file and project context
    const activeFile = editorManager && editorManager.activeFile;
    const currentFileName = activeFile ? activeFile.name : 'No file open';
    const currentFilePath = activeFile ? (activeFile.uri || activeFile.filename || currentFileName) : 'No active file';
    const currentFileDir = activeFile && activeFile.location ? activeFile.location : (currentFilePath ? currentFilePath.split('/').slice(0, -1).join('/') : '/sdcard');
    const currentFileExt = currentFileName !== 'No file open' ? currentFileName.split('.').pop() : 'unknown';
    const projectName = currentFileDir.split('/').pop() || 'Unknown Project';
    const editorContent = activeFile && editor ? editor.getValue() : '';
    const cursorPos = editor ? editor.getCursorPosition() : { row: 0, column: 0 };

    const systemPromptWithContext = `AI assistant for Acode editor. Current: ${currentFileName} (${currentFileExt}) at line ${cursorPos.row + 1}. Can edit/create/delete files, run terminal commands. Use context in responses.`;

    const prompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        systemPromptWithContext,
      ],
      ["placeholder", "{chat_history}"],
      ["human", "{input}"],
    ]);

    const parser = new StringOutputParser();
    const chain = prompt.pipe(this.modelInstance).pipe(parser);

    const withMessageHistory = new RunnableWithMessageHistory({
      runnable: chain,
      getMessageHistory: async (sessionId) => {
        if (!this.messageHistories[sessionId]) {
          this.messageHistories[sessionId] = new InMemoryChatMessageHistory();
        } else {
          let history = await this.messageHistories[sessionId].getMessages();
          this.messageHistories[sessionId].addMessages(history.slice(-6));
        }
        return this.messageHistories[sessionId];
      },
      inputMessagesKey: "input",
      historyMessagesKey: "chat_history",
    });

    const stream = await withMessageHistory.stream(
      {
        input: question,
      },
      this.messageSessionConfig,
      signal
    );

    clearInterval(this.$loadInterval);
    this.$sendBtn.classList.add("hide");
    this.$stopGenerationBtn.classList.remove("hide");

    targetElem.innerHTML = "";
    let result = "";
    let displayBuffer = "";
    let lastRenderTime = 0;
    const renderDelay = 50; // Render every 50ms for smoother streaming

    // Enhanced styling for streaming response
    targetElem.style.cssText = `
      line-height: 1.6;
      font-size: 14px;
      color: var(--primary-text-color);
      padding: 8px 12px;
      word-wrap: break-word;
      white-space: pre-wrap;
      min-height: 20px;
      border-left: 3px solid var(--accent-color);
      background: rgba(var(--accent-color-rgb), 0.05);
      border-radius: 0 8px 8px 0;
      animation: pulse 2s infinite;
    `;

    // Add cursor animation for streaming effect
    const cursor = tag("span", {
      textContent: "▊",
      className: "streaming-cursor",
      style: `
        color: var(--accent-color);
        animation: blink 1s infinite;
        margin-left: 2px;
      `
    });
    targetElem.appendChild(cursor);

    for await (const chunk of stream) {
      result += chunk;
      displayBuffer += chunk;

      // Throttled rendering for performance
      const now = Date.now();
      if (now - lastRenderTime > renderDelay || chunk.includes('\n')) {
        // Remove cursor temporarily
        if (cursor.parentNode) {
          cursor.remove();
        }

        // Update content with better formatting
        const lines = displayBuffer.split('\n');
        targetElem.innerHTML = lines.map((line, index) => {
          if (line.trim()) {
            return `<div class="response-line">${line}</div>`;
          }
          return '<br>';
        }).join('');

        // Add cursor back
        targetElem.appendChild(cursor);

        displayBuffer = "";
        lastRenderTime = now;
        this.scrollToBottom();
      }
    }

    // Remove cursor after streaming is complete
    if (cursor && cursor.parentNode) {
      cursor.remove();
    }

    // Remove streaming styles
    targetElem.style.animation = "";
    targetElem.style.border = "";
    targetElem.style.background = "";

    // Cache the response
    this.setCachedResponse(question, result);

    // Enhanced markdown rendering with animations
    if (this.$mdIt && typeof this.$mdIt.render === 'function') {
      try {
        // Use raw result for full markdown support without pre-processing
        const renderedHtml = this.$mdIt.render(result);

        // Apply with fade-in animation
        targetElem.style.opacity = "0";
        targetElem.innerHTML = renderedHtml;

        // Enhanced styling for final response
        targetElem.style.cssText = `
          line-height: 1.6;
          font-size: 14px;
          color: var(--primary-text-color);
          padding: 12px 16px;
          word-wrap: break-word;
          white-space: pre-wrap;
          border-radius: 8px;
          background: linear-gradient(145deg, rgba(var(--primary-color-rgb), 0.5), rgba(var(--primary-color-rgb), 0.8));
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          opacity: 0;
          transition: opacity 0.5s ease-in;
        `;

        // Fade in
        setTimeout(() => {
          targetElem.style.opacity = "1";
        }, 100);

        // Style code blocks and other elements
        setTimeout(() => {
          const codeBlocks = targetElem.querySelectorAll('pre code');
          codeBlocks.forEach(block => {
            block.parentElement.style.cssText = `
              background: #1e1e1e;
              border-radius: 6px;
              margin: 8px 0;
              border: 1px solid rgba(255,255,255,0.1);
            `;
          });

          const inlineCodes = targetElem.querySelectorAll('.inline-code');
          inlineCodes.forEach(code => {
            code.style.cssText = `
              background: rgba(var(--accent-color-rgb), 0.2);
              padding: 2px 6px;
              border-radius: 3px;
              font-family: monospace;
              font-size: 13px;
            `;
          });
        }, 150);

        // Add event listeners to copy buttons
        setTimeout(() => {
          const copyBtns = targetElem.querySelectorAll(".copy-button");
          if (copyBtns && copyBtns.length > 0) {
            for (const copyBtn of copyBtns) {
              copyBtn.addEventListener("click", function () {
                const codeText = this.dataset.str;
                copy(codeText);
                // Enhanced copy feedback
                this.innerHTML = '✅';
                this.style.background = '#4CAF50';
                window.toast("✅ Code copied to clipboard!", 2000);
                setTimeout(() => {
                  this.innerHTML = copyIconSvg;
                  this.style.background = '';
                }, 1500);

                // Check if this is a complete file that could be created
                if (question.toLowerCase().includes("create") ||
                    question.toLowerCase().includes("generate") ||
                    question.toLowerCase().includes("make a file")) {

                  // Offer to create file from copied code
                  setTimeout(() => {
                    const createFile = confirm("Would you like to create a file with this code?");
                    if (createFile) {
                      const filename = prompt("Enter filename:", "", "text");
                      if (filename) {
                        fs(filename).writeFile(codeText)
                          .then(() => {
                            window.toast(`File created: ${filename}`, 3000);
                            // Open the created file
                            editorManager.openFile(filename);
                          })
                          .catch(err => {
                            window.toast(`Error creating file: ${err.message}`, 3000);
                          });
                      }
                    }
                  }, 500);
                }
              });
            }
          }
        }, 100);
      } catch (renderError) {
        window.toast("Error rendering markdown", 3000);
        targetElem.textContent = result;
      }
    } else {
      targetElem.textContent = result;
    }

    this.$stopGenerationBtn.classList.add("hide");
    this.$sendBtn.classList.remove("hide");

    // Check if the response contains code that could be used to create a file
    if ((question.toLowerCase().includes("create") ||
         question.toLowerCase().includes("generate") ||
         question.toLowerCase().includes("make a file")) &&
        result.includes("```")) {

      // Extract code blocks
      const codeMatches = result.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/g);
      if (codeMatches && codeMatches.length > 0) {
        // Get the first code block content
        const codeContent = codeMatches[0].replace(/```(?:\w+)?\s*([\s\S]*?)\s*```/g, '$1').trim();

        // Offer to create file
        setTimeout(() => {
          const createFile = confirm("Would you like to create a file with the generated code?");
          if (createFile) {
            const filename = prompt("Enter filename:", "", "text");
            if (filename) {
              fs(filename).writeFile(codeContent)
                .then(() => {
                  window.toast(`File created: ${filename}`, 3000);
                  // Open the created file
                  editorManager.openFile(filename);
                })
                .catch(err => {
                  window.toast(`Error creating file: ${err.message}`, 3000);
                });
            }
          }
        }, 1000);
      }
    }

    await this.saveHistory();
  } catch (error) {
    window.toast("Error in getCliResponse", 3000);

    const responseBoxes = Array.from(document.querySelectorAll(".ai_message"));

    // Clean up intervals and UI states
    if (this.$loadInterval) {
      clearInterval(this.$loadInterval);
      this.$loadInterval = null;
    }

    // Reset button states
    if (this.$stopGenerationBtn) {
      this.$stopGenerationBtn.classList.add("hide");
    }
    if (this.$sendBtn) {
      this.$sendBtn.classList.remove("hide");
    }

    if (responseBoxes.length > 0) {
      const targetElem = responseBoxes[responseBoxes.length - 1];
      if (targetElem) {
        targetElem.innerHTML = "";
        targetElem.style.cssText = `
          padding: 12px 16px;
          border-radius: 8px;
          background: linear-gradient(145deg, #ff4444, #cc3333);
          color: white;
          margin: 8px 0;
        `;

        const $errorBox = tag("div", { 
          className: "error-box",
          style: `
            display: flex;
            align-items: center;
            gap: 8px;
          `
        });

        const errorIcon = tag("span", {
          textContent: "⚠️",
          style: "font-size: 18px;"
        });

        const errorText = tag("div");

        if (error.response) {
          errorText.innerHTML = `<strong>API Error (${error.response.status}):</strong><br>${error.response.data?.error?.message || JSON.stringify(error.response.data)}`;
        } else if (error.name === 'AbortError') {
          errorText.innerHTML = `<strong>Request Cancelled:</strong><br>Generation was stopped by user`;
        } else {
          errorText.innerHTML = `<strong>Error:</strong><br>${error.message || 'Unknown error occurred'}`;
        }

        $errorBox.append(errorIcon, errorText);
        targetElem.appendChild($errorBox);

        // Auto-scroll to show error
        this.scrollToBottom();

        // Show error toast
        window.toast("❌ AI request failed. Check your connection and API key.", 4000);
      }
    }

    this.$stopGenerationBtn.classList.add("hide");
    this.$sendBtn.classList.remove("hide");
  }
}

  async scrollToBottom() {
    this.$chatBox.scrollTop = this.$chatBox.scrollHeight;
  }

  async loader() {
    /*
    creates dot loader
    */
    // get all gptchat element for loader
    const loadingDots = Array.from(document.querySelectorAll(".ai_message"));
    if (loadingDots.length != 0) {
  let index = 0;
  let el = loadingDots[loadingDots.length - 1];
  let emojis = ["😖", "😹", "♥️", "🤓", "🗿", "🐍", "⏳", "🚀", "👍"];

  this.$loadInterval = setInterval(() => {
    el.innerText += emojis[index];
    index++;

    if (index >= emojis.length) {
      index = 0;
      el.innerText = "";
    }
  }, 300);
}
  }

  // File Operations Methods

  async createFileWithAI(basePath = "") {
    try {
      const description = await prompt("Describe the file you want to create:", "", "text", {
        required: true
      });

      if (!description) return;

      // Show loading indicator
      loader.showTitleLoader();

      // Get current directory context
      const activeFile = editorManager.activeFile;
      const currentDir = activeFile ? (activeFile.location || activeFile.uri?.split('/').slice(0, -1).join('/') || '/') : '/';
      const workingDir = currentDir !== '/' ? currentDir : '/sdcard';

      const aiPrompt = `Create file: "${description}". Return JSON: {"filename": "name.ext", "content": "code"}.`;

      const response = await this.appendGptResponse(aiPrompt);

      loader.removeTitleLoader();

      try {
        // Enhanced JSON extraction with better error handling
        let cleanResponse = response.trim();

        // Try multiple extraction patterns
        const extractionPatterns = [
          /```(?:json)?\s*(\{[\s\S]*?\})\s*```/,  // Standard JSON in code blocks
          /```[\s\S]*?(\{[\s\S]*?\})[\s\S]*?```/, // JSON inside any code block
          /(\{[\s\S]*?\})/                        // Any JSON-like structure
        ];

        let jsonStr = null;
        for (const pattern of extractionPatterns) {
          const match = cleanResponse.match(pattern);
          if (match && match[1]) {
            jsonStr = match[1];
            break;
          }
        }

        if (!jsonStr) {
          jsonStr = cleanResponse;
        }

        // Parse the JSON response with better error handling
        const suggestion = JSON.parse(jsonStr);

        // Validate required fields
        if (!suggestion.filename || !suggestion.content) {
          throw new Error('AI response missing required fields (filename or content)');
        }

        // Enhanced confirmation dialog with more information
        const confirmCreate = await multiPrompt("Create AI-Generated File", [
          {
            id: "filename",
            placeholder: "Filename",
            value: suggestion.filename,
            type: "text",
            required: true
          },
          {
            id: "targetPath",
            placeholder: "Target Directory",
            value: suggestion.suggested_path || workingDir,
            type: "text"
          },
          {
            id: "content", 
            placeholder: "File Content",
            value: suggestion.content,
            type: "textarea"
          }
        ]);

        if (confirmCreate) {
          const fileName = confirmCreate.filename;
          const content = confirmCreate.content;
          let targetDir = confirmCreate.targetPath || workingDir;

          try {
            // Validate and sanitize the target directory
            if (!targetDir || targetDir.trim() === '') {
              targetDir = workingDir;
            }

            // Use provided path or allow user to browse for directory
            let finalTargetDir = targetDir;

            // If user wants to browse for a different location
            if (targetDir === workingDir) {
              try {
                const fileBrowser = acode.require('fileBrowser');
                const dirResult = await fileBrowser('folder', `Create ${fileName} in folder:`);
                if (dirResult && dirResult.url) {
                  finalTargetDir = dirResult.url;
                }
              } catch (browserError) {
                // User cancelled browser, use the provided path
                // Silent handling - no need to log user cancellation
              }
            }

            // Ensure the target directory exists and create the file
            const targetFs = await fs(finalTargetDir);
            const createdFileUrl = await targetFs.createFile(fileName, content);

            // Show success message with full path information
            const relativePath = createdFileUrl.replace(/^.*\//, '');
            window.toast(`✅ File created successfully!\n📁 ${finalTargetDir}/${relativePath}`, 4000);

            // Close the AI assistant page if it's open
            if (this.$page && this.$page.isVisible) {
              this.$page.hide();
            }

            // Open the created file in the editor
            try {
              await editorManager.openFile(createdFileUrl);
            } catch (error) {
              // Fallback: create new editor file
              const EditorFile = acode.require('editorFile');
              new EditorFile(fileName, {
                text: content,
                render: true
              });
            }
          } catch (error) {
            // Better error handling without logging to ACODE.log
            const errorMessage = error && error.message ? error.message : 'Unknown error occurred';
            window.toast(`❌ Error creating file: ${errorMessage}`, 4000);
          }
        }
      } catch (parseError) {
        // Handle parsing error without console logging

        // Extract code blocks if JSON parsing fails
        const codeMatch = response.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
        const extractedContent = codeMatch ? codeMatch[1] : response;

        // Fallback to manual filename input
        const filename = await prompt("Enter filename for the generated content:", "", "text", { required: true });
        if (filename) {
          const fullPath = basePath ? `${basePath}/${filename}` : filename;
          await fs(fullPath).writeFile(extractedContent);
          window.toast(`File created: ${filename}`, 3000);

          // Close the AI assistant page if it's open
          if (this.$page && this.$page.isVisible) {
            this.$page.hide();
          }

          // Open the created file
          const openedFile = await editorManager.openFile(fullPath);
          if (!openedFile) {
            editorManager.addNewFile(filename, {
              text: extractedContent
            });
          }
        }
      }
    } catch (error) {
      window.toast("Error creating file with AI", 3000);
      window.toast(`Error creating file: ${error.message}`, 3000);
    }
  }

  async renameFileIntelligently(filePath) {
    try {
      if (!await fs(filePath).exists()) {
        throw new Error("File not found");
      }

      const content = await fs(filePath).readFile('utf8');
      const currentName = filePath.split('/').pop();

      const aiPrompt = `Analyze this file content and suggest a better filename:

      Current name: ${currentName}
      Content:
      \`\`\`
      ${content.substring(0, 1000)}
      \`\`\`

      Suggest 3 alternative filenames that better describe the file's purpose. Consider:
      1. File content and functionality
      2. Naming conventions
      3. Descriptive but concise names

      Respond with just the filenames, one per line.`;

      const response = await this.appendGptResponse(aiPrompt);
      const suggestions = response.split('\n').filter(name => name.trim());

      const selectedName = await select("Choose new filename:", [currentName, ...suggestions]);

      if (selectedName && selectedName !== currentName) {
        const newPath = filePath.replace(currentName, selectedName);
        await fs(filePath).moveTo(newPath);
        window.toast(`File renamed to: ${selectedName}`, 3000);

        // Update editor if file is open
        const openFile = editorManager.getFile(filePath);
        if (openFile) {
          openFile.filename = selectedName;
          openFile.name = selectedName;
        }
      }
    } catch (error) {
      window.toast(`Error renaming file: ${error.message}`, 3000);
    }
  }

  async organizeProjectStructure() {
    try {
      loader.showTitleLoader();
      window.toast("Scanning project structure...", 2000);

      const projectFiles = await this.scanProjectStructure();

      if (!projectFiles || projectFiles.length === 0) {
        loader.removeTitleLoader();
        window.toast("No project files found to organize", 3000);
        return;
      }

      const aiPrompt = `Project structure analysis for organization:

Files found: ${projectFiles.length}
${projectFiles.slice(0, 20).map(f => `- ${f.name} (${f.type})`).join('\n')}

Suggest improvements:
1. Better folder organization
2. Files to move/group
3. New directories needed
4. Cleanup recommendations

Response format: Clear actionable steps.`;

      const response = await this.appendGptResponse(aiPrompt);
      loader.removeTitleLoader();

      // Show suggestions in chat
      if (!this.$page.isVisible) {
        await this.run();
      }

      this.appendUserQuery("📁 Analyze and suggest project structure improvements");
      this.appendGptResponse(`📋 **Project Organization Analysis**\n\n${response}\n\n✨ *Use bulk operations to implement these suggestions*`);

    } catch (error) {
      loader.removeTitleLoader();
      window.toast(`❌ Error analyzing project: ${error.message}`, 3000);
    }
  }

  async scanProjectStructure() {
    // Cache project structure for 5 minutes
    if (this.projectStructure && this.lastStructureScan && 
        (Date.now() - this.lastStructureScan) < 300000) {
      return this.projectStructure;
    }

    try {
      const structure = {};
      const scanDir = async (dirPath, depth = 0) => {
        if (depth > 3) return; // Limit depth

        try {
          const dirFs = fs(dirPath);
          if (dirFs && await dirFs.exists()) {
            const items = await dirFs.lsDir();
            structure[dirPath] = {
              files: [],
              folders: []
            };

            for (const item of items) {
              if (item.isDirectory && !item.name.startsWith('.')) {
                structure[dirPath].folders.push(item.name);
                await scanDir(`${dirPath}/${item.name}`, depth + 1);
              } else if (item.isFile) {
                structure[dirPath].files.push({
                  name: item.name,
                  size: item.length || 0,
                  extension: item.name.split('.').pop() || 'unknown'
                });
              }
            }
          }
        } catch (error) {
          window.toast('Error scanning directory', 3000);
        }
      };

      await scanDir(window.PLUGIN_DIR || '/sdcard');

      this.projectStructure = structure;
      this.lastStructureScan = Date.now();

      return structure;
    } catch (error) {
      window.toast('Error scanning project structure', 3000);
      return {};
    }
  }

  async bulkFileOperations() {
    try {
      const operation = await select("Bulk Operation", [
        "Rename multiple files",
        "Move files to folders", 
        "Delete unused files",
        "Add headers to files",
        "Convert file formats"
      ]);

      switch (operation) {
        case "Rename multiple files":
          await this.bulkRenameFiles();
          break;
        case "Move files to folders":
          await this.bulkMoveFiles();
          break;
        case "Delete unused files":
          await this.deleteUnusedFiles();
          break;
        case "Add headers to files":
          await this.addHeadersToFiles();
          break;
        case "Convert file formats":
          await this.convertFileFormats();
          break;
      }
    } catch (error) {
      window.toast(`Bulk operation error: ${error.message}`, 3000);
    }
  }

  async bulkRenameFiles() {
    try {
      const files = await this.selectMultipleFiles();
      if (!files.length) {
        window.toast("No files selected", 3000);
        return;
      }

      const pattern = await prompt("Enter naming pattern (use {index} for numbers):", "file_{index}.js", "text");
      if (!pattern) return;

      const confirmRename = await select(`Rename ${files.length} files using pattern: ${pattern}?`, ["Yes", "No"]);
      if (confirmRename === "Yes") {
        loader.showTitleLoader();
        let renamedCount = 0;

        for (let i = 0; i < files.length; i++) {
          try {
            const fileFs = await fs(files[i]);
            if (await fileFs.exists()) {
              const oldName = files[i].split('/').pop();
              const extension = oldName.includes('.') ? '.' + oldName.split('.').pop() : '';
              const newName = pattern.replace('{index}', i + 1).replace(/\.[^.]*$/, '') + extension;

              await fileFs.renameTo(newName);
              renamedCount++;
            }
          } catch (err) {
            window.toast('Error renaming file', 3000);
          }
        }

        loader.removeTitleLoader();
        window.toast(`✅ Renamed ${renamedCount} files`, 4000);
      }
    } catch (error) {
      loader.removeTitleLoader();
      window.toast(`❌ Bulk rename error: ${error.message}`, 3000);
    }
  }

  async bulkMoveFiles() {
    try {
      // First select files to move
      const files = await this.selectMultipleFiles();
      if (!files.length) {
        window.toast("No files selected", 3000);
        return;
      }

      const fileBrowser = acode.require('fileBrowser');

      // Then select target folder
      const targetResult = await fileBrowser('folder', 'Select target folder for files');
      if (!targetResult) {
        window.toast("No target folder selected", 3000);
        return;
      }

      const targetFolder = targetResult.url;

      // Ensure target folder exists
      try {
        const targetFs = fs(targetFolder);
        if (!await targetFs.exists()) {
          window.toast("Target folder not accessible", 3000);
          return;
        }
      } catch (err) {
        window.toast("Cannot access target folder", 3000);
        return;
      }

      const confirmMove = await select(`Move ${files.length} files to ${targetResult.name}?`, ["Yes", "No"]);
      if (confirmMove === "Yes") {
        loader.showTitleLoader();
        let movedCount = 0;

        for (const filePath of files) {
          try {
            const fileFs = fs(filePath);
            if (await fileFs.exists()) {
              const fileName = filePath.split('/').pop();
              const newPath = `${targetFolder}/${fileName}`;
              await fileFs.moveTo(newPath);
              movedCount++;
            }
          } catch (err) {
            window.toast('Error moving file', 3000);
          }
        }

        loader.removeTitleLoader();
        window.toast(`✅ Moved ${movedCount} files to ${targetResult.name}`, 4000);
      }
    } catch (error) {
      loader.removeTitleLoader();
      window.toast(`❌ Bulk move error: ${error.message}`, 3000);
    }
  }

  async deleteUnusedFiles() {
    try {
      const extensions = await multiPrompt("Select file types to analyze", [
        {
          id: "extensions",
          placeholder: "Extensions (e.g., .log,.tmp,.bak)",
          value: ".log,.tmp,.bak,.backup",
          type: "text",
          required: true
        }
      ]);

      if (!extensions) return;

      const extensionList = extensions.extensions.split(',').map(ext => ext.trim());
      const unusedFiles = await this.getAllProjectFiles(extensionList);

      if (!unusedFiles.length) {
        window.toast("No unused files found", 3000);
        return;
      }

      const fileList = unusedFiles.map(f => f.split('/').pop()).join('\n');
      const confirmDelete = await select(`Delete ${unusedFiles.length} unused files?\n\n${fileList.substring(0, 200)}${fileList.length > 200 ? '...' : ''}`, ["Yes", "No"]);

      if (confirmDelete === "Yes") {
        let deletedCount = 0;
        for (const filePath of unusedFiles) {
          try {
            const fileFs = fs(filePath);
            if (fileFs && await fileFs.exists()) {
              await fileFs.delete();
              deletedCount++;
            }
          } catch (err) {
            window.toast('Error deleting file', 3000);
          }
        }
        window.toast(`Deleted ${deletedCount} unused files`, 3000);
      }
    } catch (error) {
      window.toast(`Delete unused files error: ${error.message}`, 3000);
    }
  }

  async addHeadersToFiles() {
    try {
      const headerInfo = await multiPrompt("File Header Configuration", [
        {
          id: "header",
          placeholder: "Header template (use {filename}, {date}, {author})",
          value: "/*\n * File: {filename}\n * Created: {date}\n * Author: {author}\n */\n",
          type: "textarea",
          required: true
        },
        {
          id: "author", 
          placeholder: "Author name",
          value: "Developer",
          type: "text"
        },
        {
          id: "extensions",
          placeholder: "File extensions (e.g., .js,.css,.html)",
          value: ".js,.css,.html",
          type: "text",
          required: true
        }
      ]);

      if (!headerInfo) return;

      const extensionList = headerInfo.extensions.split(',').map(ext => ext.trim());
      const files = await this.getAllProjectFiles(extensionList);

      if (!files.length) {
        window.toast("No matching files found", 3000);
        return;
      }

      const confirmAdd = await select(`Add headers to ${files.length} files?`, ["Yes", "No"]);
      if (confirmAdd === "Yes") {
        let processedCount = 0;
        for (const filePath of files) {
          try {
            const fileFs = fs(filePath);
            if (fileFs && await fileFs.exists()) {
              const content = await fileFs.readFile('utf8');
              const fileName = filePath.split('/').pop();
              const currentDate = new Date().toLocaleDateString();

              const header = headerInfo.header
                .replace('{filename}', fileName)
                .replace('{date}', currentDate)
                .replace('{author}', headerInfo.author);

              // Check if header already exists
              if (!content.startsWith(header.trim())) {
                const newContent = header + content;
                await fileFs.writeFile(newContent);
                processedCount++;
              }
            }
          } catch (err) {
            window.toast('Error adding header', 3000);
          }
        }
        window.toast(`Added headers to ${processedCount} files`, 3000);
      }
    } catch (error) {
      window.toast(`Add headers error: ${error.message}`, 3000);
    }
  }

  async convertFileFormats() {
    try {
      const conversion = await multiPrompt("File Format Conversion", [
        {
          id: "fromExt",
          placeholder: "From extension (e.g., .txt)",
          value: ".txt",
          type: "text",
          required: true
        },
        {
          id: "toExt",
          placeholder: "To extension (e.g., .md)",
          value: ".md", 
          type: "text",
          required: true
        }
      ]);

      if (!conversion) return;

      const files = await this.getAllProjectFiles([conversion.fromExt]);

      if (!files.length) {
        window.toast(`No ${conversion.fromExt} files found`, 3000);
        return;
      }

      const confirmConvert = await select(`Convert ${files.length} files from ${conversion.fromExt} to ${conversion.toExt}?`, ["Yes", "No"]);
      if (confirmConvert === "Yes") {
        let convertedCount = 0;
        for (const filePath of files) {
          try {
            const fileFs = fs(filePath);
            if (fileFs && await fileFs.exists()) {
              const content = await fileFs.readFile('utf8');
              const baseName = filePath.replace(conversion.fromExt, '');
              const newPath = baseName + conversion.toExt;

              // Create new file with converted extension
              const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
              const parentFs = fs(parentDir);
              const newFileName = newPath.split('/').pop();

              if (parentFs) {
                await parentFs.createFile(newFileName, content);
                await fileFs.delete(); // Delete original file
                convertedCount++;
              }
            }
          } catch (err) {
            window.toast('Error converting file', 3000);
          }
        }
        window.toast(`Converted ${convertedCount} files`, 3000);
      }
    } catch (error) {
      window.toast(`Convert file formats error: ${error.message}`, 3000);
    }
  }

  async selectMultipleFiles() {
    try {
      const fileBrowser = acode.require('fileBrowser');
      const fileList = acode.require('fileList');
      const selectedFiles = [];

      // Get all open folders for context
      const openFolders = await fileList();

      if (openFolders.length === 0) {
        window.toast("Please open a folder first", 3000);
        return [];
      }

      let continueSelection = true;
      let selectionCount = 0;

      while (continueSelection && selectionCount < 10) { // Limit to 10 files
        try {
          const result = await fileBrowser('file', `Select files (${selectionCount} selected)`, false, openFolders);

          if (result && result.url && !selectedFiles.includes(result.url)) {
            selectedFiles.push(result.url);
            selectionCount++;

            const continuePrompt = await select(`Added ${result.name}. Continue selecting?`, ["Yes", "Done"]);
            if (continuePrompt === "Done" || continuePrompt === null) {
              continueSelection = false;
            }
          } else {
            // User cancelled or no file selected
            continueSelection = false;
          }
        } catch (error) {
          // User cancelled or error occurred
          continueSelection = false;
        }
      }

      return selectedFiles;
    } catch (error) {
      window.toast('Error in selectMultipleFiles', 3000);
      window.toast(`Error selecting files: ${error.message}`, 3000);
      return [];
    }
  }

  async readFileContent(filePath) {
    /*
    Read file content from project
    */
    try {
      if (await fs(filePath).exists()) {
        const content = await fs(filePath).readFile('utf8');
        return { success: true, content, path: filePath };
      } else {
        return { success: false, error: `File not found: ${filePath}` };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async editFileContent(filePath, newContent) {
    /*
    Edit file content in project with backup using proper Acode API
    */
    try {
      const fileFs = await fs(filePath);

      // Create backup before editing
      if (await fileFs.exists()) {
        const originalContent = await fileFs.readFile('utf8');
        const backupPath = filePath + '.backup.' + Date.now();
        const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
        const parentFs = await fs(parentDir);
        const backupFileName = backupPath.split('/').pop();

        // Create backup file
        await parentFs.createFile(backupFileName, originalContent);

        // Store backup info for undo
        this.storeUndoInfo(filePath, originalContent);

        // Write new content
        await fileFs.writeFile(newContent);

        // Update open editor file if it's currently open
        const activeFile = editorManager.activeFile;
        if (activeFile && (activeFile.uri === filePath || activeFile.location + '/' + activeFile.filename === filePath)) {
          activeFile.session.setValue(newContent);
          activeFile.isUnsaved = false;
        }
      } else {
        // File doesn't exist, create it
        const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
        const fileName = filePath.split('/').pop();
        const parentFs = await fs(parentDir);
        await parentFs.createFile(fileName, newContent);
      }

      return { success: true, message: `File edited successfully: ${filePath.split('/').pop()}` };
    } catch (error) {
      window.toast('Error editing file content', 3000);
      return { success: false, error: error.message };
    }
  }

  async deleteFileFromProject(filePath) {
    /*
    Delete file from project with backup
    */
    try {
      if (await fs(filePath).exists()) {
        // Create backup before deleting
        const content = await fs(filePath).readFile('utf8');
        const backupPath = window.DATA_STORAGE + 'deleted_files/' + Date.now() + '_' + filePath.split('/').pop();
        await fs(backupPath).writeFile(content);

        await fs(filePath).delete();
        return { success: true, message: `File deleted successfully: ${filePath}` };
      } else {
        return { success: false, error: `File not found: ${filePath}` };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async showFileDiff(originalContent, newContent, filename) {
    /*
    Show diff between original and new content with enhanced visualization
    */
    try {
      // Improved diff implementation
      const originalLines = originalContent.split('\n');
      const newLines = newContent.split('\n');

      // Create header with file info
      let diffHtml = `
        <div class="diff-container">
          <div class="diff-header">
            <h4>Changes in ${filename}</h4>
            <div class="diff-stats">
              <span class="diff-summary">Showing changes from ${originalLines.length} to ${newLines.length} lines</span>
            </div>
          </div>
          <div class="diff-content">
      `;

      // Track consecutive unchanged lines for collapsing
      let unchangedCount = 0;
      let unchangedBuffer = [];
      const contextLines = 3; // Number of context lines to show around changes

      // Function to flush unchanged lines with context
      const flushUnchanged = () => {
        if (unchangedCount <= contextLines * 2) {
          // If small number of unchanged lines, show all
          unchangedBuffer.forEach(line => {
            diffHtml += line;
          });
        } else {
          // Show only context lines at beginning and end
          for (let i = 0; i < contextLines; i++) {
            diffHtml += unchangedBuffer[i];
          }

          // Add collapse indicator
          diffHtml += `<div class="diff-collapse">... ${unchangedCount - (contextLines * 2)} more unchanged lines ...</div>`;

          // Show context lines at end
          for (let i = unchangedBuffer.length - contextLines; i < unchangedBuffer.length; i++) {
            diffHtml += unchangedBuffer[i];
          }
        }

        unchangedCount = 0;
        unchangedBuffer = [];
      };

      // Enhanced diff algorithm with context
      const maxLines = Math.max(originalLines.length, newLines.length);
      let hasChanges = false;

      for (let i = 0; i < maxLines; i++) {
        const origLine = originalLines[i] || '';
        const newLine = newLines[i] || '';

        // Remove HTML escaping to preserve markdown formatting
        const escapeHtml = (text) => {
          // Return text as-is to preserve markdown and code formatting
          return text;
        };

        const escapedOrigLine = origLine; // No escaping for better formatting
        const escapedNewLine = newLine; // No escaping for better formatting

        if (origLine !== newLine) {
          // Flush any accumulated unchanged lines before showing changes
          if (unchangedCount > 0) {
            flushUnchanged();
          }

          hasChanges = true;

          if (origLine && newLine) {
            // Modified line
            diffHtml += `<div class="diff-line modified">
              <span class="line-num">${i + 1}</span>
              <span class="old-line">- ${escapedOrigLine}</span>
              <span class="new-line">+ ${escapedNewLine}</span>
            </div>`;
          } else if (origLine && !newLine) {
            // Deleted line
            diffHtml += `<div class="diff-line deleted">
              <span class="line-num">${i + 1}</span>
              <span class="old-line">- ${escapedOrigLine}</span>
            </div>`;
          } else if (!origLine && newLine) {
            // Added line
            diffHtml += `<div class="diff-line added">
              <span class="line-num">${i + 1}</span>
              <span class="new-line">+ ${escapedNewLine}</span>
            </div>`;
          }
        } else {
          // Unchanged line - accumulate for potential collapsing
          unchangedCount++;
          unchangedBuffer.push(`<div class="diff-line unchanged">
            <span class="line-num">${i + 1}</span>
            <span class="unchanged-line">${escapedOrigLine}</span>
          </div>`);
        }
      }

      // Flush any remaining unchanged lines
      if (unchangedCount > 0) {
        flushUnchanged();
      }

      // If no changes detected, show a message
      if (!hasChanges) {
        diffHtml += `<div class="diff-no-changes">No changes detected</div>`;
      }

      diffHtml += `
          </div>
        </div>
      `;

      return diffHtml;
    } catch (error) {
      window.toast('Error generating diff', 3000);
      return `<div class="error">Error showing diff: ${error.message}</div>`;
    }
  }

  async searchAndReplaceInProject(searchTerm, replaceTerm, fileExtensions = ['.js', '.json', '.html', '.css', '.md']) {
    /*
    Search and replace across all project files
    */
    try {
      const results = [];
      const projectFiles = await this.getAllProjectFiles(fileExtensions);

      for (const filePath of projectFiles) {
        if (await fs(filePath).exists()) {
          const content = await fs(filePath).readFile('utf8');
          if (content.includes(searchTerm)) {
            const newContent = content.replace(new RegExp(searchTerm, 'g'), replaceTerm);
            await this.editFileContent(filePath, newContent);
            results.push({
              file: filePath,
              occurrences: (content.match(new RegExp(searchTerm, 'g')) || []).length
            });
          }
        }
      }

      return { success: true, results, message: `Replaced "${searchTerm}" with "${replaceTerm}" in ${results.length} files` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getAllProjectFiles(extensions) {
    /*
    Get all project files with specified extensions
    */
    try {
      const files = [];
      const scanDirectory = async (dirPath) => {
        if (await fs(dirPath).exists()) {
          const items = await fs(dirPath).lsDir();
          for (const item of items) {
            const fullPath = `${dirPath}/${item.name}`;
            if (item.isDirectory && !item.name.startsWith('.')) {
              await scanDirectory(fullPath);
            } else if (item.isFile) {
              const hasValidExt = extensions.some(ext => item.name.endsWith(ext));
              if (hasValidExt) {
                files.push(fullPath);
              }
            }
          }
        }
      };

      // Scan open folders first, fallback to root directories
      const fileList = acode.require('fileList');
      const openFolders = await fileList();

      if (openFolders.length > 0) {
        for (const folder of openFolders) {
          await scanDirectory(folder.url);
        }
      } else {
        // Fallback to common directories if no folders are open
        const commonDirs = ['/sdcard', '/storage/emulated/0', window.DATA_STORAGE];
        for (const dir of commonDirs) {
          try {
            await scanDirectory(dir);
            break; // Use first accessible directory
          } catch (error) {
            continue;
          }
        }
      }
      return files;
    } catch (error) {
      window.toast('Error scanning project files', 3000);
      return [];
    }
  }

  storeUndoInfo(filePath, content) {
    /*
    Store file state for undo operations
    */
    if (!this.undoStack) this.undoStack = [];
    this.undoStack.push({ filePath, content, timestamp: Date.now() });

    // Keep only last 10 undo operations
    if (this.undoStack.length > 10) {
      this.undoStack.shift();
    }
  }

  async undoLastOperation() {
    /*
    Undo last file operation
    */
    try {
      if (!this.undoStack || this.undoStack.length === 0) {
        return { success: false, error: 'No operations to undo' };
      }

      const lastOp = this.undoStack.pop();
      const fileFs = await fs(lastOp.filePath);
      await fileFs.writeFile(lastOp.content);

      // Update open editor file if it's currently open
      const activeFile = editorManager.activeFile;
      if (activeFile && (activeFile.uri === lastOp.filePath || activeFile.location + '/' + activeFile.filename === lastOp.filePath)) {
        activeFile.session.setValue(lastOp.content);
        activeFile.isUnsaved = false;
      }

      return { success: true, message: `Undone changes to ${lastOp.filePath.split('/').pop()}` };
    } catch (error) {
      window.toast('Error in undoLastOperation', 3000);
      return { success: false, error: error.message };
    }
  }

  async readRelatedFiles(currentFilePath) {
  try {
    if (!await fs(currentFilePath).exists()) {
      return { success: false, error: 'Current file not found' };
    }

    const content = await fs(currentFilePath).readFile('utf8');
    const imports = [];

    // Match import/require patterns
    const importRegex = /(?:import.*from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1] || match[2];
      if (importPath && !importPath.startsWith('http') && !importPath.includes('node_modules')) {
        imports.push(importPath);
      }
    }

    const relatedFiles = [];
    const basePath = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));

    for (const importPath of imports) {
      let resolvedPath;

      // Resolve relative paths
      if (importPath.startsWith('./')) {
        resolvedPath = `${basePath}/${importPath.substring(2)}`;
      } else if (importPath.startsWith('../')) {
        // Handle multiple levels of ../
        const upLevels = (importPath.match(/\.\.\//g) || []).length;
        let parentPath = basePath;

        for (let i = 0; i < upLevels; i++) {
          const lastSlash = parentPath.lastIndexOf('/');
          if (lastSlash > 0) {
            parentPath = parentPath.substring(0, lastSlash);
          }
        }

        const remainingPath = importPath.replace(/\.\.\//g, '');
        resolvedPath = `${parentPath}/${remainingPath}`;
      } else if (importPath.startsWith('/')) {
        resolvedPath = importPath;
      } else {
        resolvedPath = `${basePath}/${importPath}`;
      }

      // Try different extensions
      const extensions = ['', '.js', '.json', '.ts', '.jsx', '.tsx', '.vue', '.css', '.scss'];
      let found = false;

      for (const ext of extensions) {
        const fullPath = resolvedPath + ext;
        try {
          if (await fs(fullPath).exists()) {
            const fileContent = await fs(fullPath).readFile('utf8');
            relatedFiles.push({ path: fullPath, content: fileContent });
            found = true;
            break;
          }
        } catch (error) {
          // Continue trying other extensions
          continue;
        }
      }

      if (!found) {
        // Could not resolve import
      }
    }

    return { success: true, files: relatedFiles, imports };
  } catch (error) {
    window.toast('Error reading related files', 3000);
    return { success: false, error: error.message };
  }
}


  // Enhanced UI and Direct Editing Features
  createProviderDropdown() {
    const dropdown = tag("div", {
      className: "provider-dropdown"
    });

    const select = tag("select", {
      className: "provider-select",
      id: "ai-provider-select"
    });

    AI_PROVIDERS.forEach(provider => {
      const option = tag("option", {
        value: provider,
        textContent: provider
      });
      select.appendChild(option);
    });

    // Set current provider
    const currentProvider = window.localStorage.getItem("ai-assistant-provider");
    if (currentProvider) {
      select.value = currentProvider;
    }

    select.addEventListener('change', async (e) => {
      await this.switchProvider(e.target.value);
    });

    dropdown.appendChild(select);
    return dropdown;
  }

  createTokenDisplay() {
    const tokenDisplay = tag("div", {
      className: "token-display",
      id: "token-usage-display"
    });

    const tokenIcon = tag("span", {
      className: "token-icon",
      textContent: "🪙"
    });

    this.$tokenText = tag("span", {
      className: "token-text",
      textContent: "0"
    });

    tokenDisplay.appendChild(tokenIcon);
    tokenDisplay.appendChild(this.$tokenText);
    
    tokenDisplay.onclick = () => this.showTokenUsageDetails();
    
    this.updateTokenDisplay();
    return tokenDisplay;
  }

  loadTokenUsage() {
    try {
      const stored = localStorage.getItem('ai-assistant-token-usage');
      if (stored) {
        const data = JSON.parse(stored);
        const today = new Date().toDateString();
        
        if (data.lastReset !== today) {
          // Reset daily counter
          data.today = 0;
          data.lastReset = today;
        }
        
        this.tokenUsage = { ...this.tokenUsage, ...data };
      }
    } catch (error) {
      window.toast('Error loading token usage', 3000);
    }
  }

  saveTokenUsage() {
    try {
      localStorage.setItem('ai-assistant-token-usage', JSON.stringify(this.tokenUsage));
    } catch (error) {
      window.toast('Error saving token usage', 3000);
    }
  }

  updateTokenUsage(tokens) {
    this.tokenUsage.total += tokens;
    this.tokenUsage.today += tokens;
    this.tokenUsage.session += tokens;
    this.saveTokenUsage();
    this.updateTokenDisplay();
  }

  updateTokenDisplay() {
    if (this.$tokenText) {
      const { session, today } = this.tokenUsage;
      this.$tokenText.textContent = `${session}`;
      this.$tokenText.title = `Session: ${session} | Today: ${today}`;
    }
  }

  async showTokenUsageDetails() {
    const { total, today, session } = this.tokenUsage;
    const currentProvider = localStorage.getItem('ai-assistant-provider') || 'None';
    
    const details = `📊 Token Usage Statistics
    
🔹 Current Session: ${session.toLocaleString()} tokens
🔹 Today: ${today.toLocaleString()} tokens  
🔹 Total: ${total.toLocaleString()} tokens
🔹 Provider: ${currentProvider}

💡 Tip: Use shorter prompts and enable caching to reduce token usage.`;

    await acode.alert('Token Usage', details);
  }

  async searchInChat() {
    try {
      const searchTerm = await prompt("Search in chat:", "", "text");
      if (!searchTerm) return;
      
      const chatMessages = this.$chatBox.querySelectorAll('.message, .ai_message');
      let foundCount = 0;
      
      chatMessages.forEach(msg => {
        const text = msg.textContent.toLowerCase();
        msg.style.backgroundColor = '';
        msg.style.border = '';
        
        if (text.includes(searchTerm.toLowerCase())) {
          msg.style.backgroundColor = 'rgba(0, 212, 255, 0.2)';
          msg.style.border = '2px solid var(--galaxy-star-blue)';
          foundCount++;
        }
      });
      
      if (foundCount > 0) {
        window.toast(`Found ${foundCount} messages containing "${searchTerm}"`, 4000);
        // Scroll to first match
        const firstMatch = this.$chatBox.querySelector('[style*="border: 2px solid"]');
        if (firstMatch) {
          firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else {
        window.toast(`No messages found containing "${searchTerm}"`, 3000);
      }
    } catch (error) {
      window.toast('Error searching chat', 3000);
    }
  }

  async clearChatHistory() {
    try {
      const confirm = await select("Clear all chat history?", ["Yes", "No"]);
      if (confirm === "Yes") {
        this.$chatBox.innerHTML = "";
        this.messageHistories = {};
        this.messageSessionConfig = {
          configurable: {
            sessionId: uuidv4(),
          },
        };
        CURRENT_SESSION_FILEPATH = null;
        window.toast("✅ Chat history cleared", 3000);
      }
    } catch (error) {
      window.toast('❌ Error clearing chat', 3000);
    }
  }

  async exportConversation() {
    try {
      const chatMessages = this.$chatBox.querySelectorAll('.wrapper, .ai_wrapper');
      if (chatMessages.length === 0) {
        window.toast("No conversation to export", 3000);
        return;
      }
      
      let exportText = `# AI Chat Conversation\nExported: ${new Date().toLocaleString()}\nProvider: ${localStorage.getItem('ai-assistant-provider') || 'Unknown'}\n\n`;
      
      chatMessages.forEach((wrapper, index) => {
        const isUser = wrapper.classList.contains('wrapper');
        const message = wrapper.querySelector('.message, .ai_message');
        const text = message ? message.textContent.trim() : '';
        
        if (text) {
          exportText += `## ${isUser ? 'User' : 'AI Assistant'} (${index + 1})\n${text}\n\n`;
        }
      });
      
      const blob = new Blob([exportText], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-chat-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
      
      window.toast("📁 Conversation exported successfully", 3000);
    } catch (error) {
      window.toast('Error exporting conversation', 3000);
      window.toast('❌ Export failed', 3000);
    }
  }

  async copyAllMessages() {
    try {
      const chatMessages = this.$chatBox.querySelectorAll('.wrapper, .ai_wrapper');
      if (chatMessages.length === 0) {
        window.toast("No messages to copy", 3000);
        return;
      }
      
      let allText = '';
      chatMessages.forEach((wrapper, index) => {
        const isUser = wrapper.classList.contains('wrapper');
        const message = wrapper.querySelector('.message, .ai_message');
        const text = message ? message.textContent.trim() : '';
        
        if (text) {
          allText += `${isUser ? 'User' : 'AI'}: ${text}\n\n`;
        }
      });
      
      if (copy(allText)) {
        window.toast("📋 All messages copied to clipboard", 3000);
      } else {
        window.toast("❌ Failed to copy messages", 3000);
      }
    } catch (error) {
      window.toast('❌ Copy failed', 3000);
    }
  }

  async showSettings() {
    try {
      const currentProvider = localStorage.getItem('ai-assistant-provider') || 'None';
      const currentModel = localStorage.getItem('ai-assistant-model-name') || 'None';
      const { total, today, session } = this.tokenUsage;
      
      const settings = await select("Settings", [
        "Change Provider",
        "Change Model", 
        "Toggle Real-time Analysis",
        "Clear Token Usage",
        "Reset All Settings",
        "Back"
      ]);
      
      switch (settings) {
        case "Change Provider":
          const newProvider = await select("Select Provider", AI_PROVIDERS);
          if (newProvider) {
            await this.switchProvider(newProvider);
          }
          break;
          
        case "Change Model":
          const provider = localStorage.getItem('ai-assistant-provider');
          if (provider) {
            const apiKey = await this.apiKeyManager.getAPIKey(provider);
            const models = await getModelsFromProvider(provider, apiKey);
            const newModel = await select("Select Model", models);
            if (newModel) {
              localStorage.setItem('ai-assistant-model-name', newModel);
              this.initiateModel(provider, apiKey, newModel);
              window.toast(`Switched to ${newModel}`, 3000);
            }
          }
          break;
          
        case "Toggle Real-time Analysis":
          this.toggleRealTimeAI();
          break;
          
        case "Clear Token Usage":
          const confirmClear = await select("Clear token usage statistics?", ["Yes", "No"]);
          if (confirmClear === "Yes") {
            this.tokenUsage = { total: 0, today: 0, session: 0, lastReset: new Date().toDateString() };
            this.saveTokenUsage();
            this.updateTokenDisplay();
            window.toast("Token usage cleared", 3000);
          }
          break;
          
        case "Reset All Settings":
          const confirmReset = await select("Reset all plugin settings?", ["Yes", "No"]);
          if (confirmReset === "Yes") {
            localStorage.removeItem('ai-assistant-provider');
            localStorage.removeItem('ai-assistant-model-name');
            localStorage.removeItem('ai-assistant-token-usage');
            this.tokenUsage = { total: 0, today: 0, session: 0, lastReset: new Date().toDateString() };
            this.updateTokenDisplay();
            window.toast("All settings reset", 3000);
          }
          break;
      }
    } catch (error) {
      window.toast('Error in settings', 3000);
      window.toast('❌ Settings error', 3000);
    }
  }

  async switchProvider(newProvider) {
  try {
    // Validate provider
    if (!AI_PROVIDERS.includes(newProvider) && newProvider !== OPENAI_LIKE) {
      throw new Error('Invalid provider selected');
    }

    const previousProvider = window.localStorage.getItem("ai-assistant-provider");
    if (previousProvider === newProvider) {
      return; // No change needed
    }

    // Handle different provider types
    if (newProvider === "Ollama") {
      // No API key needed for Ollama
      window.localStorage.setItem("ai-assistant-provider", newProvider);

      // Get available models for Ollama
      try {
        loader.showTitleLoader();
        window.toast("Fetching available models...", 2000);
        const modelList = await getModelsFromProvider(newProvider, "No Need Of API Key");
        loader.removeTitleLoader();

        const modelName = await select("Select AI Model", modelList);
        if (modelName) {
          window.localStorage.setItem("ai-assistant-model-name", modelName);
          await this.apiKeyManager.saveAPIKey(newProvider, "No Need Of API Key");
          this.initiateModel(newProvider, "No Need Of API Key", modelName);
          window.toast(`Switched to ${newProvider}`, 3000);
        }
      } catch (error) {
        // Revert to previous provider
        if (previousProvider) {
          window.localStorage.setItem("ai-assistant-provider", previousProvider);
        }
        throw error;
      }
    } else if (newProvider === OPENAI_LIKE) {
      // Handle OpenAI-Like providers
      const apiKey = await prompt("API Key", "", "password", { required: true });
      if (!apiKey) {
        return;
      }

      const baseUrl = await prompt("API Base URL", "https://api.openai.com/v1", "text", {
        required: true
      });

      const modelName = await prompt("Model", "", "text", { required: true });
      if (!modelName) {
        return;
      }

      // Save settings
      window.localStorage.setItem("ai-assistant-provider", OPENAI_LIKE);
      window.localStorage.setItem("ai-assistant-model-name", modelName);
      window.localStorage.setItem("openai-like-baseurl", baseUrl);

      await this.apiKeyManager.saveAPIKey(OPENAI_LIKE, apiKey);
      this.initiateModel(OPENAI_LIKE, apiKey, modelName);
      window.toast(`Switched to ${newProvider}`, 3000);
    } else {
      // Handle other providers (OpenAI, Google, Groq, etc.)
      const apiKey = await prompt(`Enter API key for ${newProvider}:`, "", "password", {
        required: true
      });

      if (!apiKey) {
        return;
      }

      try {
        loader.showTitleLoader();
        window.toast("Fetching available models...", 2000);
        const modelList = await getModelsFromProvider(newProvider, apiKey);
        loader.removeTitleLoader();

        const modelName = await select("Select AI Model", modelList);
        if (modelName) {
          window.localStorage.setItem("ai-assistant-provider", newProvider);
          window.localStorage.setItem("ai-assistant-model-name", modelName);

          if (this.apiKeyManager) {
            await this.apiKeyManager.saveAPIKey(newProvider, apiKey);
          }

          this.initiateModel(newProvider, apiKey, modelName);
          window.toast(`Switched to ${newProvider}`, 3000);
        }
      } catch (error) {
        // Revert to previous provider
        if (previousProvider) {
          window.localStorage.setItem("ai-assistant-provider", previousProvider);
        }
        throw error;
      }
    }
  } catch (error) {
    window.toast('Error switching provider', 3000);
    window.toast(`Error switching provider: ${error.message}`, 3000);
  }
}

  showAiEditPopup(initialText = "") {
    // Create backdrop for better focus and visibility
    const backdrop = tag("div", {
      className: "ai-edit-backdrop"
    });

    const popup = tag("div", {
      className: "ai-edit-popup"
    });

    const header = tag("div", {
      className: "ai-edit-popup-header"
    });

    const title = tag("div", {
      className: "ai-edit-popup-title",
      textContent: "Edit with AI"
    });

    const closeBtn = tag("button", {
      className: "ai-edit-popup-close",
      innerHTML: "&times;"
    });

    header.append(title, closeBtn);

    const body = tag("div", {
      className: "ai-edit-popup-body"
    });

    const promptArea = tag("textarea", {
      className: "ai-edit-prompt",
      placeholder: "Describe what you want to do with the code...\nExample: 'Add error handling to this function' or 'Optimize this loop for better performance'",
      value: initialText
    });

    const actions = tag("div", {
      className: "ai-edit-actions"
    });

    const cancelBtn = tag("button", {
      className: "ai-edit-btn secondary",
      textContent: "Cancel"
    });

    const editBtn = tag("button", {
      className: "ai-edit-btn primary",
      textContent: "Edit Code"
    });

    actions.append(cancelBtn, editBtn);
    body.append(promptArea, actions);
    popup.append(header, body);

    // Enhanced close functionality
    const closePopup = () => {
      if (document.body.contains(backdrop)) {
        document.body.removeChild(backdrop);
      }
      if (document.body.contains(popup)) {
        document.body.removeChild(popup);
      }
    };

    // Event listeners
    closeBtn.onclick = cancelBtn.onclick = closePopup;

    // Close when clicking backdrop
    backdrop.onclick = (e) => {
      if (e.target === backdrop) {
        closePopup();
      }
    };

    editBtn.onclick = async () => {
      const prompt = promptArea.value.trim();
      if (prompt) {
        closePopup();
        await this.processAiEdit(prompt);
      } else {
        window.toast("Please enter editing instructions", 3000);
        promptArea.focus();
      }
    };

    // Handle keyboard shortcuts
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        closePopup();
        document.removeEventListener('keydown', handleKeyDown);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        editBtn.click();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    // Append elements and focus
    document.body.append(backdrop, popup);

    // Auto-focus with slight delay for better UX
    setTimeout(() => {
      promptArea.focus();
      if (initialText) {
        promptArea.setSelectionRange(initialText.length, initialText.length);
      }
    }, 100);
  }

  async processAiEdit(userPrompt) {
  // Input validation
  if (!userPrompt || userPrompt.trim().length === 0) {
    window.toast("Please provide editing instructions", 3000);
    return;
  }

  const loadingToast = window.toast("AI is processing your request...", 0);

  try {
    const activeFile = editorManager.activeFile;
    if (!activeFile) {
      throw new Error("No active file to edit");
    }

    const currentContent = editor.getValue();
    const selection = editor.getSelectedText();
    const fileExtension = activeFile.name.split('.').pop();

    // Get file context information
    const filePath = activeFile.uri || activeFile.filename || activeFile.name;
    const fileDirectory = activeFile.location || (filePath ? filePath.split('/').slice(0, -1).join('/') : '');
    const cursorPos = editor.getCursorPosition();

    let aiPrompt;
    if (selection) {
      aiPrompt = `EDIT SELECTED CODE REQUEST

**FILE CONTEXT:**
• File: ${activeFile.name}
• Path: ${filePath}
• Directory: ${fileDirectory}
• Language: ${fileExtension}
• Selection: Lines around ${cursorPos.row + 1}

**SELECTED CODE TO EDIT:**
\`\`\`${fileExtension}
${selection}
\`\`\`

**USER EDIT REQUEST:** "${userPrompt}"

**EDITING REQUIREMENTS:**
- Focus ONLY on the selected code block
- Maintain existing functionality unless specifically requested to change
- Follow ${fileExtension} best practices and conventions
- Make minimal but effective changes
- Preserve variable names and structure unless requested otherwise
- Return ONLY the edited code block (no explanations)

**OUTPUT:** Provide the improved code block ready to replace the selection:`;
    } else {
      // Full file edit with complete context
      aiPrompt = `EDIT ENTIRE FILE REQUEST

**FILE CONTEXT:**
• File: ${activeFile.name}
• Path: ${filePath}
• Directory: ${fileDirectory}
• Language: ${fileExtension}
• File Size: ${currentContent.length} characters
• Current Cursor: Line ${cursorPos.row + 1}, Column ${cursorPos.column + 1}

**CURRENT FILE CONTENT:**
\`\`\`${fileExtension}
${currentContent}
\`\`\`

**USER EDIT REQUEST:** "${userPrompt}"

**EDITING REQUIREMENTS:**
- Apply changes throughout the file as needed
- Maintain overall file structure and organization
- Follow ${fileExtension} best practices and conventions
- Ensure all existing functionality remains intact
- Make improvements that align with the request
- Preserve imports, exports, and dependencies
- Return the complete improved file (no explanations)

**OUTPUT:** Provide the complete edited file ready to replace current content:`;
    }

    const response = await this.appendGptResponse(aiPrompt);

    // FIX: Proper response validation
    const hasValidResponse = response !== null && response !== undefined && typeof response === 'string' && response.trim().length > 0;
    
    if (hasValidResponse) {
      // Enhanced code extraction with better pattern matching
      let newCode = response.trim();

      // Try multiple patterns to extract code
      const codeBlockPatterns = [
        /```[\w]*\s*([\s\S]*?)\s*```/g,  // Standard code blocks
        /~~~[\w]*\s*([\s\S]*?)\s*~~~/g,  // Alternative code blocks
        /<code>([\s\S]*?)<\/code>/g,     // HTML code tags
        /`([^`\n]+)`/g                   // Inline code (single line)
      ];

      let codeMatch = null;
      for (const pattern of codeBlockPatterns) {
        const matches = [...response.matchAll(pattern)];
        if (matches.length > 0 && matches[0][1]) {
          // Take the largest code block found
          codeMatch = matches.reduce((largest, current) => 
            current[1].length > largest[1].length ? current : largest
          );
          break;
        }
      }

      if (codeMatch && codeMatch[1]) {
        newCode = codeMatch[1].trim();
        // Code extracted from block
      } else {
        // Enhanced filtering for explanatory text
        const lines = response.split('\n');
        const codeLines = lines.filter(line => {
          const trimmed = line.trim();
          return (
            trimmed && // Not empty
            !trimmed.startsWith('#') &&           // Not markdown heading
            !trimmed.startsWith('>') &&           // Not quote
            !trimmed.match(/^[0-9]+\.\s/) &&      // Not numbered list
            !trimmed.match(/^\*\s/) &&             // Not bullet list
            !trimmed.match(/^-\s/) &&              // Not dash list  
            !trimmed.match(/^Here'?s?\s/i) &&       // Not explanation
            !trimmed.match(/^The\s+code\s+/i) &&   // Not description
            !trimmed.match(/^This\s+code\s+/i) &&  // Not description
            !trimmed.match(/^I['']?ve?\s+/i)       // Not personal explanation
          );
        });

        if (codeLines.length > 0) {
          newCode = codeLines.join('\n').trim();
          // Code extracted by filtering
        } else {
          // No code patterns matched, using full response
        }
      }

      // Show diff before applying
      const shouldApply = await this.showEditDiff(selection || currentContent, newCode, activeFile.name);

      if (shouldApply) {
        if (selection) {
          // Replace just the selected text
          const currentPos = editor.getCursorPosition();
          editor.session.replace(editor.selection.getRange(), newCode);

          // Try to maintain cursor position
          editor.moveCursorToPosition(currentPos);
        } else {
          // Replace entire file content
          const currentPos = editor.getCursorPosition();
          const scrollTop = editor.session.getScrollTop();

          editor.setValue(newCode, -1); // -1 to keep undo history

          // Restore cursor and scroll position
          editor.moveCursorToPosition(currentPos);
          editor.session.setScrollTop(scrollTop);
        }

        // Enhanced file saving with better error handling
        if (activeFile && activeFile.uri) {
          try {
            // FIX: Safe method calling
            try {
              if (activeFile.markModified) {
                activeFile.markModified();
              }
            } catch (markError) {
              // markModified failed
            }

            // Use Acode's built-in save method if available
            let saveSuccess = false;
            try {
              if (activeFile.save) {
                await activeFile.save();
                saveSuccess = true;
              }
            } catch (saveError) {
              // activeFile.save failed
            }

            if (!saveSuccess) {
              // Fallback to direct file write
              await fs(activeFile.uri).writeFile(editor.getValue());
            }

            window.toast("✅ File updated and saved successfully!", 3000);

            // FIX: Safe event triggering
            try {
              const editorMgr = window.editorManager;
              if (editorMgr && editorMgr.onUpdate) {
                editorMgr.onUpdate();
              }
            } catch (updateError) {
              // onUpdate failed
            }

          } catch (saveError) {
            window.toast('Error saving file', 3000);
            window.toast(`⚠️ Code updated but couldn't save: ${saveError.message}`, 4000);

            // Suggest manual save
            setTimeout(() => {
              window.toast("💡 Try Ctrl+S to save manually", 3000);
            }, 1000);
          }
        } else if (activeFile) {
          // File exists but no URI (new file)
          window.toast("✅ Code updated! Save file to persist changes.", 3000);
        } else {
          window.toast("⚠️ No active file found", 2000);
        }
      }
    } else {
      throw new Error("No response from AI");
    }
  } catch (error) {
    window.toast('Error in processAiEdit', 3000);
    window.toast(`Error: ${error.message}`, 3000);
  } finally {
    // FIX: Safe cleanup
    try {
      if (loadingToast && loadingToast.hide) {
        loadingToast.hide();
      }
    } catch (hideError) {
      // Failed to hide loading toast
    }
  }
}

  async showEditDiff(originalCode, newCode, filename) {
    // Generate diff HTML
    const diffHtml = await this.showFileDiff(originalCode, newCode, filename);

    // Create a modal dialog for the diff viewer
    const dialog = tag("div", {
      className: "ai-edit-popup",
      style: `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 90%;
        max-width: 800px;
        max-height: 80vh;
        background: var(--primary-color);
        color: var(--primary-text-color);
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        z-index: 1000;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      `
    });

    // Create a semi-transparent backdrop
    const backdrop = tag("div", {
      style: `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 999;
      `
    });

    const header = tag("div", {
      className: "ai-edit-popup-header",
      style: `
        padding: 15px;
        border-bottom: 1px solid var(--border-color);
        display: flex;
        justify-content: space-between;
        align-items: center;
      `
    });

    const title = tag("div", {
      className: "ai-edit-popup-title",
      textContent: `Review Changes: ${filename}`,
      style: `
        font-size: 18px;
        font-weight: bold;
      `
    });

    const closeBtn = tag("button", {
      innerHTML: "X",
      style: `
        background: none;
        border: none;
        font-size: 24px;
        cursor: pointer;
        color: var(--primary-text-color);
      `
    });

    header.append(title, closeBtn);

    const body = tag("div", {
      className: "ai-edit-popup-body",
      innerHTML: diffHtml,
      style: `
        padding: 15px;
        overflow-y: auto;
        flex: 1;
      `
    });

    // Add custom styles for diff display
    const diffStyles = tag("style", {
      textContent: `
        .diff-container {
          font-family: monospace;
          white-space: pre-wrap;
          word-break: break-all;
        }
        .diff-line {
          padding: 2px 5px;
          margin: 2px 0;
          border-radius: 3px;
          position: relative;
        }
        .diff-line.added {
          background-color: rgba(0, 255, 0, 0.1);
          border-left: 3px solid #4CAF50;
        }
        .diff-line.deleted {
          background-color: rgba(255, 0, 0, 0.1);
          border-left: 3px solid #F44336;
        }
        .diff-line.modified {
          background-color: rgba(255, 165, 0, 0.1);
          border-left: 3px solid #FF9800;
        }
        .line-num {
          display: inline-block;
          width: 40px;
          color: #888;
          user-select: none;
        }
        .old-line {
          display: block;
          color: #F44336;
          text-decoration: line-through;
          margin-bottom: 5px;
        }
        .new-line {
          display: block;
          color: #4CAF50;
        }
      `
    });

    document.head.appendChild(diffStyles);

    const actions = tag("div", {
      className: "ai-edit-actions",
      style: `
        padding: 15px;
        border-top: 1px solid var(--border-color);
        display: flex;
        justify-content: flex-end;
        gap: 10px;
      `
    });

    const cancelBtn = tag("button", {
      className: "ai-edit-btn secondary",
      textContent: "Cancel",
      style: `
        padding: 8px 16px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        background: var(--secondary-color);
        color: var(--secondary-text-color);
      `
    });

    const applyBtn = tag("button", {
      className: "ai-edit-btn primary",
      textContent: "Apply Changes",
      style: `
        padding: 8px 16px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        background: var(--accent-color);
        color: var(--accent-text-color);
        font-weight: bold;
      `
    });

    actions.append(cancelBtn, applyBtn);
    dialog.append(header, body, actions);
    document.body.append(backdrop, dialog);

    // Add event listeners for keyboard navigation
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        document.body.removeChild(dialog);
        document.body.removeChild(backdrop);
        document.removeEventListener("keydown", handleKeyDown);
        resolve(false);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        document.body.removeChild(dialog);
        document.body.removeChild(backdrop);
        document.removeEventListener("keydown", handleKeyDown);
        resolve(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return new Promise((resolve) => {
      closeBtn.onclick = cancelBtn.onclick = () => {
        document.body.removeChild(dialog);
        document.body.removeChild(backdrop);
        document.removeEventListener("keydown", handleKeyDown);
        resolve(false);
      };

      applyBtn.onclick = () => {
        document.body.removeChild(dialog);
        document.body.removeChild(backdrop);
        document.removeEventListener("keydown", handleKeyDown);
        resolve(true);
      };

      // Close when clicking on backdrop
      backdrop.onclick = () => {
        document.body.removeChild(dialog);
        document.body.removeChild(backdrop);
        document.removeEventListener("keydown", handleKeyDown);
        resolve(false);
      };
    });
  }

  async handleSelectionAction(action, selectedText) {
  const activeFile = editorManager.activeFile;

  switch (action) {
    case "Explain Code":
      await this.explainCodeWithChat(selectedText, activeFile);
      break;
    case "Rewrite":
      await this.rewriteCodeWithChat(selectedText);
      break;
    case "Generate Code":
      await this.showGenerateCodePopup();
      break;
    case "Optimize Function":
      await this.optimizeFunctionWithChat(selectedText);
      break;
    case "Add Comments":
      await this.addCommentsWithChat(selectedText);
      break;
    case "Generate Docs":
      await this.generateDocsWithChat(selectedText);
      break;
    case "Edit with AI":
      this.showAiEditPopup();
      break;
  }
}

  async explainCodeWithChat(selectedText, activeFile) {
  try {
    // Enhanced chat opening with comprehensive null safety
    if (!this.$page || !this.$page.isVisible) {
      await this.run();
    }

    // Additional null safety checks
    if (!editorManager) {
      window.toast('⚠️ Editor not available', 3000);
      return;
    }

    // Enhanced null safety for file context
    const fileName = activeFile && activeFile.name ? activeFile.name : 'Unknown';
    const fileExtension = fileName !== 'Unknown' ? fileName.split('.').pop() || 'txt' : 'txt';

    const systemPrompt = `You are a professional code explainer. Focus on the selected code provided and explain it clearly and comprehensively.`;

    // Get comprehensive file context
    const filePath = activeFile && activeFile.uri ? activeFile.uri : fileName;
    const fileDirectory = activeFile && activeFile.location ? activeFile.location : (filePath ? filePath.split('/').slice(0, -1).join('/') : 'Unknown');
    const projectContext = fileDirectory !== 'Unknown' ? fileDirectory.split('/').pop() : 'Current Project';

    // Enhanced prompt with better structure and context
    const userPrompt = `CODE EXPLANATION REQUEST

**FILE CONTEXT:**
• File: ${fileName}
• Path: ${filePath}
• Directory: ${fileDirectory}
• Project: ${projectContext}
• Language: ${fileExtension}

**SELECTED CODE BLOCK:**
\`\`\`${fileExtension}
${selectedText}
\`\`\`

**EXPLANATION REQUESTED:**
Please provide a comprehensive explanation covering:

1. **FUNCTIONALITY**: What this code does (main purpose and behavior)
2. **HOW IT WORKS**: Step-by-step breakdown of the logic
3. **TECHNICAL DETAILS**: Key concepts, patterns, and algorithms used
4. **DEPENDENCIES**: Required imports, libraries, or external resources
5. **CONTEXT**: How this fits within the larger file/project structure
6. **OPTIMIZATION**: Potential improvements and best practices
7. **USE CASES**: Common scenarios where this code would be useful
8. **RELATED CODE**: What other parts of the project might interact with this

Focus specifically on the selected code while considering its context within the file.`;

    this.appendUserQuery(userPrompt);
    this.scrollToBottom();
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
  } catch (error) {
    window.toast('Error in explainCodeWithChat', 3000);
    window.toast(`Error explaining code: ${error.message}`, 3000);
  }
}

  async showGenerateCodePopup() {
  const popup = tag("div", {
    className: "ai-edit-popup"
  });

  const header = tag("div", {
    className: "ai-edit-popup-header"
  });

  const title = tag("div", {
    className: "ai-edit-popup-title",
    textContent: "Generate Code"
  });

  const closeBtn = tag("button", {
    className: "ai-edit-popup-close",
    innerHTML: "X"
  });

  header.append(title, closeBtn);

  const body = tag("div", {
    className: "ai-edit-popup-body"
  });

  const promptArea = tag("textarea", {
    className: "ai-edit-prompt",
    placeholder: "Describe what code you want to generate...\nExample: 'Create a function to validate email addresses'"
  });

  const actions = tag("div", {
    className: "ai-edit-actions"
  });

  const cancelBtn = tag("button", {
    className: "ai-edit-btn secondary",
    textContent: "Cancel"
  });

  const generateBtn = tag("button", {
    className: "ai-edit-btn primary",
    textContent: "Generate Code"
  });

  actions.append(cancelBtn, generateBtn);
  body.append(promptArea, actions);
  popup.append(header, body);

  // Event listeners
  closeBtn.onclick = cancelBtn.onclick = () => {
    if (document.body.contains(popup)) {
      document.body.removeChild(popup);
    }
  };

  generateBtn.onclick = async () => {
    const userPrompt = promptArea.value.trim();
    if (userPrompt) {
      if (document.body.contains(popup)) {
        document.body.removeChild(popup);
      }
      await this.processCodeGeneration(userPrompt);
    } else {
      window.toast("Please enter a description", 3000);
    }
  };

  // Handle Enter key
  promptArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      generateBtn.click();
    }
  });

  document.body.appendChild(popup);
  promptArea.focus();
}

  async processCodeGeneration(userPrompt) {
  // Input validation
  if (!userPrompt || userPrompt.trim().length === 0) {
    window.toast("Please provide a description for code generation", 3000);
    return;
  }

  if (userPrompt.length > 1000) {
    window.toast("Description too long. Please keep it under 1000 characters", 3000);
    return;
  }

  const activeFile = editorManager.activeFile;
  let fileContent = "";
  let fileExtension = "js"; // default extension

  if (activeFile) {
    fileContent = editor.getValue();
    fileExtension = activeFile.name.split('.').pop() || "js";
  }

  // Show loading
  loader.showTitleLoader();
  window.toast("Generating code...", 3000);

  try {
    // Improved prompt for better code generation
    const systemPrompt = `You are a professional code generator. Generate clean, efficient, and well-documented code based on user requirements.

**Instructions:**
1. Generate ONLY the requested code - no explanations
2. Use proper syntax for ${fileExtension} files
3. Include necessary imports/dependencies
4. Follow best practices and conventions
5. Make code production-ready with error handling`;

    const aiPrompt = `${systemPrompt}

**File Type:** ${fileExtension}
**User Request:** ${userPrompt}

Generate the ${fileExtension} code:`;

// Try to get AI response with fallback
let response;
try {
  response = await this.appendGptResponse(aiPrompt);
} catch (error) {
  window.toast('Primary AI service failed', 4000);
  // Fallback: try with basic model if advanced fails
  try {
    response = await this.sendAiQuery(aiPrompt);
  } catch (fallbackError) {
    window.toast('Fallback AI service also failed', 4000);
    response = null;
  }
}

    // Extract code from response
    const codeMatch = response.match(/```[\w]*\n([\s\S]*?)\n```/);
    let generatedCode = codeMatch ? codeMatch[1].trim() : response.trim();

    // Clean up common AI response artifacts
    generatedCode = generatedCode
      .replace(/^Here'?s the code:?\s*/i, '')
      .replace(/^The code is:?\s*/i, '')
      .replace(/^```[\w]*\n?/g, '')
      .replace(/\n?```$/g, '')
      .trim();

    if (!generatedCode) {
      throw new Error("No valid code generated");
    }

    // Insert at cursor position
    const cursor = editor.getCursorPosition();
    editor.session.insert(cursor, generatedCode + '\n');

    // Auto-save if file exists
    if (activeFile && activeFile.uri) {
      try {
        await activeFile.save();
        window.toast("Code generated and saved successfully!", 3000);
      } catch (saveError) {
        window.toast("Code generated! Please save manually.", 3000);
      }
    } else {
      window.toast("Code generated successfully!", 3000);
    }

    // Ask if user wants to run the code
    setTimeout(async () => {
      const shouldRun = await select("Run the generated code?", ["Yes", "No", "Cancel"]);
      if (shouldRun === "Yes") {
        this.runCurrentFile(); // Removed await since we're not checking the result
      }
    }, 1000);

  } catch (error) {
    window.toast('Error generating code', 3000);
    window.toast(`Error: ${error.message}`, 4000);

    // Show fallback options
    setTimeout(async () => {
      const fallback = await select("Code generation failed. Try:", ["Retry", "Chat Mode", "Cancel"]);
      if (fallback === "Retry") {
        this.processCodeGeneration(userPrompt); // Removed await since we're not checking the result
      } else if (fallback === "Chat Mode") {
        if (!this.$page.isVisible) {
          await this.run();
        }
        this.appendUserQuery(`Generate code: ${userPrompt}`);
        this.sendAiQuery(userPrompt); // Removed await since we're not checking the result
      }
    }, 500);
  } finally {
    loader.removeTitleLoader();
  }
}

  async runCurrentFile() {
    /*
    Run current file using terminal or built-in Acode runner
    */
    try {
      const activeFile = editorManager.activeFile;
      if (!activeFile || !activeFile.uri) {
        window.toast("No file to run", 3000);
        return;
      }

      const fileName = activeFile.name;
      const fileExtension = fileName.split('.').pop().toLowerCase();
      const filePath = activeFile.uri;

      // Save file first if needed
      if (activeFile.isUnsaved) {
        await activeFile.save();
      }

      // Handle different file types
      switch (fileExtension) {
        case 'html':
        case 'htm':
          // Use Acode's built-in F5 runner for HTML files
          await this.runHtmlFile(activeFile);
          break;

        case 'py':
          await this.runPythonFile(filePath, fileName);
          break;

        case 'js':
          await this.runJavaScriptFile(filePath, fileName);
          break;

        case 'cpp':
        case 'c':
          await this.runCppFile(filePath, fileName, fileExtension);
          break;

        case 'java':
          await this.runJavaFile(filePath, fileName);
          break;

        case 'go':
          await this.runGoFile(filePath, fileName);
          break;

        case 'rs':
          await this.runRustFile(filePath, fileName);
          break;

        case 'php':
          await this.runPhpFile(filePath, fileName);
          break;

        case 'rb':
          await this.runRubyFile(filePath, fileName);
          break;

        default:
          window.toast(`Running ${fileExtension} files is not supported yet`, 3000);
          break;
      }

    } catch (error) {
      window.toast('Error running file', 3000);
      window.toast(`Error running file: ${error.message}`, 3000);
    }
  }

  async runHtmlFile(activeFile) {
    /*
    Run HTML file using Acode's built-in runner (F5)
    */
    try {
      // Try to use the built-in run command
      if (await activeFile.canRun()) {
        activeFile.run();
        window.toast("Running HTML file in browser...", 3000);
      } else {
        // Fallback: use the manual F5 approach
        window.toast("Press F5 to run HTML file in preview", 3000);
        // Trigger F5 programmatically if possible
        const keyEvent = new KeyboardEvent('keydown', {
          key: 'F5',
          code: 'F5',
          keyCode: 116,
          which: 116,
          bubbles: true,
          cancelable: true
        });
        document.dispatchEvent(keyEvent);
      }
    } catch (error) {
      window.toast('Error running HTML file', 3000);
      window.toast("Please press F5 to run HTML file", 3000);
    }
  }

  async runPythonFile(filePath, fileName) {
    /*
    Run Python file in terminal
    */
    try {
      const term = await terminal.create({
        name: `Python - ${fileName}`,
        theme: 'dark',
      });

      // Navigate to file directory and run
      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      const commands = [
        `cd "${fileDir}"`,
        `python3 "${fileName}" || python "${fileName}"`
      ];

      for (const cmd of commands) {
        terminal.write(term.id, cmd + '\r\n');
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      window.toast(`Running ${fileName} in terminal...`, 3000);
    } catch (error) {
      window.toast('Error running Python file', 3000);
      window.toast(`Error running Python: ${error.message}`, 3000);
    }
  }

  async runJavaScriptFile(filePath, fileName) {
    /*
    Run JavaScript file in terminal using Node.js
    */
    try {
      const term = await terminal.create({
        name: `Node - ${fileName}`,
        theme: 'dark',
      });

      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      const commands = [
        `cd "${fileDir}"`,
        `node "${fileName}"`
      ];

      for (const cmd of commands) {
        terminal.write(term.id, cmd + '\r\n');
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      window.toast(`Running ${fileName} with Node.js...`, 3000);
    } catch (error) {
      window.toast('Error running JavaScript file', 3000);
      window.toast(`Error running JavaScript: ${error.message}`, 3000);
    }
  }

  async runCppFile(filePath, fileName, extension) {
    /*
    Compile and run C/C++ file
    */
    try {
      const term = await terminal.create({
        name: `C++ - ${fileName}`,
        theme: 'dark',
      });

      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      const baseName = fileName.replace(`.${extension}`, '');
      const compiler = extension === 'cpp' ? 'g++' : 'gcc';

      const commands = [
        `cd "${fileDir}"`,
        `${compiler} "${fileName}" -o "${baseName}" && ./"${baseName}"`
      ];

      for (const cmd of commands) {
        terminal.write(term.id, cmd + '\r\n');
        await new Promise(resolve => setTimeout(resolve, 800));
      }

      window.toast(`Compiling and running ${fileName}...`, 3000);
    } catch (error) {
      window.toast('Error running C++ file', 3000);
      window.toast(`Error running C++: ${error.message}`, 3000);
    }
  }

  async runJavaFile(filePath, fileName) {
    /*
    Compile and run Java file
    */
    try {
      const term = await terminal.create({
        name: `Java - ${fileName}`,
        theme: 'dark',
      });

      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      const baseName = fileName.replace('.java', '');

      const commands = [
        `cd "${fileDir}"`,
        `javac "${fileName}" && java "${baseName}"`
      ];

      for (const cmd of commands) {
        terminal.write(term.id, cmd + '\r\n');
        await new Promise(resolve => setTimeout(resolve, 800));
      }

      window.toast(`Compiling and running ${fileName}...`, 3000);
    } catch (error) {
      window.toast('Error running Java file', 3000);
      window.toast(`Error running Java: ${error.message}`, 3000);
    }
  }

  async runGoFile(filePath, fileName) {
    /*
    Run Go file
    */
    try {
      const term = await terminal.create({
        name: `Go - ${fileName}`,
        theme: 'dark',
      });

      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      const commands = [
        `cd "${fileDir}"`,
        `go run "${fileName}"`
      ];

      for (const cmd of commands) {
        terminal.write(term.id, cmd + '\r\n');
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      window.toast(`Running ${fileName} with Go...`, 3000);
    } catch (error) {
      window.toast('Error running Go file', 3000);
      window.toast(`Error running Go: ${error.message}`, 3000);
    }
  }

  async runRustFile(filePath, fileName) {
    /*
    Compile and run Rust file
    */
    try {
      const term = await terminal.create({
        name: `Rust - ${fileName}`,
        theme: 'dark',
      });

      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      const baseName = fileName.replace('.rs', '');

      const commands = [
        `cd "${fileDir}"`,
        `rustc "${fileName}" -o "${baseName}" && ./"${baseName}"`
      ];

      for (const cmd of commands) {
        terminal.write(term.id, cmd + '\r\n');
        await new Promise(resolve => setTimeout(resolve, 800));
      }

      window.toast(`Compiling and running ${fileName}...`, 3000);
    } catch (error) {
      window.toast('Error running Rust file', 3000);
      window.toast(`Error running Rust: ${error.message}`, 3000);
    }
  }

  async runPhpFile(filePath, fileName) {
    /*
    Run PHP file
    */
    try {
      const term = await terminal.create({
        name: `PHP - ${fileName}`,
        theme: 'dark',
      });

      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      const commands = [
        `cd "${fileDir}"`,
        `php "${fileName}"`
      ];

      for (const cmd of commands) {
        terminal.write(term.id, cmd + '\r\n');
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      window.toast(`Running ${fileName} with PHP...`, 3000);
    } catch (error) {
      window.toast('Error running PHP file', 3000);
      window.toast(`Error running PHP: ${error.message}`, 3000);
    }
  }

  async runRubyFile(filePath, fileName) {
    /*
    Run Ruby file
    */
    try {
      const term = await terminal.create({
        name: `Ruby - ${fileName}`,
        theme: 'dark',
      });

      const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
      const commands = [
        `cd "${fileDir}"`,
        `ruby "${fileName}"`
      ];

      for (const cmd of commands) {
        terminal.write(term.id, cmd + '\r\n');
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      window.toast(`Running ${fileName} with Ruby...`, 3000);
    } catch (error) {
      window.toast('Error running Ruby file', 3000);
      window.toast(`Error running Ruby: ${error.message}`, 3000);
    }
  }

  async generateCode(description) {
    const prompt = `Generate code based on this description: ${description}`;
    await this.sendAiQuery(prompt);
  }

  async optimizeFunctionWithChat(selectedText) {
  try {
    if (!this.$page || !this.$page.isVisible) {
      await this.run();
    }

  const activeFile = editorManager.activeFile;
  const fileExtension = activeFile ? activeFile.name.split('.').pop() : 'code';

  const systemPrompt = `You are a code optimization expert. Focus on the selected code and provide optimizations for better performance, readability, and maintainability.`;

  const userPrompt = `Please optimize this ${fileExtension} code:

**Selected Code:**
\`\`\`${fileExtension}
${selectedText}
\`\`\`

Optimization requirements:
- Improve performance and efficiency
- Enhance readability and maintainability
- Follow ${fileExtension} best practices
- Maintain existing functionality
- Provide clear explanations for each optimization

Provide the optimized code with detailed explanations:`;

    this.appendUserQuery(userPrompt);
    this.scrollToBottom();
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
  } catch (error) {
    window.toast('Error in optimizeFunctionWithChat', 3000);
    window.toast(`Error optimizing function: ${error.message}`, 3000);
  }
}

  async addCommentsWithChat(selectedText) {
  try {
    if (!this.$page || !this.$page.isVisible) {
      await this.run();
    }

  const activeFile = editorManager.activeFile;
  const fileExtension = activeFile ? activeFile.name.split('.').pop() : 'code';

  const systemPrompt = `You are a documentation expert. Add comprehensive, professional comments to the selected code only.`;

  const userPrompt = `Please add detailed comments to this ${fileExtension} code:

**Selected Code:**
\`\`\`${fileExtension}
${selectedText}
\`\`\`

Comment requirements:
1. Explain what each section/function does
2. Document parameters and their types
3. Describe return values
4. Clarify complex logic or algorithms
5. Add JSDoc/appropriate format for ${fileExtension}
6. Keep comments concise but informative

Return the code with appropriate comments added:`;

    this.appendUserQuery(userPrompt);
    this.scrollToBottom();
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
  } catch (error) {
    window.toast('Error in addCommentsWithChat', 3000);
    window.toast(`Error adding comments: ${error.message}`, 3000);
  }
}

  async generateDocsWithChat(selectedText) {
  if (!this.$page.isVisible) {
    await this.run();
  }

  const activeFile = editorManager.activeFile;
  const fileName = activeFile ? activeFile.name : 'Unknown';
  const fileExtension = fileName.split('.').pop();

  if (selectedText) {
    // Generate docs for selection only - avoid full file content
    const systemPrompt = `Generate docs for selected code only.`;

    const userPrompt = `Document ${fileExtension} code:
\`\`\`
${selectedText}
\`\`\`
Include: JSDoc, params, returns, examples.`;

    this.appendUserQuery(userPrompt);
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
  } else {
    window.toast("Please select code to generate documentation", 3000);
  }
}

  async sendAiQuery(prompt) {
    // Open the AI assistant if not already open
    if (!this.$page.isVisible) {
      await this.run();
    }

    // Add the query to chat
    this.appendUserQuery(prompt);
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(prompt);
  }

  initializeMarkdown() {
  if (!this.$mdIt && window.markdownit) {
    this.$mdIt = window.markdownit({
      html: false,
      xhtmlOut: false,
      breaks: true,
      linkify: true,
      typographer: true,
      quotes: '""\'\'',
      highlight: function (str, lang) {
        const copyBtn = document.createElement("button");
        copyBtn.classList.add("copy-button");
        copyBtn.innerHTML = copyIconSvg;
        copyBtn.setAttribute("data-str", str);
        const codesArea = `<pre class="hljs codesArea"><code>${window.hljs ? window.hljs.highlightAuto(str).value : str}</code></pre>`;
        const codeBlock = `<div class="codeBlock">${copyBtn.outerHTML}${codesArea}</div>`;
        return codeBlock;
      },
    });
  }
  return this.$mdIt;
}

  async rewriteCodeWithChat(selectedText) {
  if (!this.$page.isVisible) {
    await this.run();
  }

  const activeFile = editorManager.activeFile;
  const fileExtension = activeFile ? activeFile.name.split('.').pop() : 'code';

  const systemPrompt = `Rewrite code: cleaner, efficient, same functionality.`;

  const userPrompt = `Rewrite ${fileExtension} code:
\`\`\`
${selectedText}
\`\`\`
Make cleaner, more efficient. Same functionality.`;

  this.appendUserQuery(userPrompt);
  this.appendGptResponse("");
  this.loader();
  await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
}

  // Safe UTF-8 encoding function to replace btoa
  safeBase64Encode(str) {
    try {
      // Convert to UTF-8 bytes first, then to base64
      return btoa(unescape(encodeURIComponent(str)));
    } catch (error) {
      // Fallback: create a simple hash-like string if encoding fails
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return Math.abs(hash).toString(36);
    }
  }

  // Cache Management
  getCacheKey(prompt, provider, model) {
    return `${provider}_${model}_${this.safeBase64Encode(prompt).substring(0, 50)}`;
  }

  getCachedResponse(prompt) {
    const provider = window.localStorage.getItem("ai-assistant-provider");
    const model = window.localStorage.getItem("ai-assistant-model-name");
    const key = this.getCacheKey(prompt, provider, model);

    const cached = this.responseCache.get(key);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
      return cached.response;
    }

    // Remove expired cache
    if (cached) {
      this.responseCache.delete(key);
    }

    return null;
  }

  setCachedResponse(prompt, response) {
    const provider = window.localStorage.getItem("ai-assistant-provider");
    const model = window.localStorage.getItem("ai-assistant-model-name");
    const key = this.getCacheKey(prompt, provider, model);

    this.responseCache.set(key, {
      response,
      timestamp: Date.now()
    });

    // Limit cache size
    if (this.responseCache.size > 100) {
      const firstKey = this.responseCache.keys().next().value;
      this.responseCache.delete(firstKey);
    }
  }

  clearCache() {
    this.responseCache.clear();
    this.fileCache.clear();
    this.projectStructure = null;
    this.lastStructureScan = null;
    window.toast("Cache cleared", 2000);
  }

  // Helper functions for real-time AI optimization
  getContentDifference(newContent, oldContent) {
    if (!oldContent) return Infinity;
    if (newContent === oldContent) return 0;

    // Simple character difference count
    let diff = 0;
    const maxLength = Math.max(newContent.length, oldContent.length);
    for (let i = 0; i < maxLength; i++) {
      if (newContent[i] !== oldContent[i]) diff++;
    }
    return diff;
  }

  getRealTimeCacheKey(content, cursorPos) {
    // Create a simplified cache key based on content hash and cursor position
    const contentHash = this.safeBase64Encode(content.substring(0, 500)).substring(0, 20);
    return `realtime_${contentHash}_${cursorPos.row}_${Math.floor(cursorPos.column / 10)}`;
  }

  setupRealTimeAI() {
  // Toggle real-time AI command
  editor.commands.addCommand({
    name: "toggle_realtime_ai",
    description: "Toggle Real-time Renz Ai",
    bindKey: { win: "Ctrl-Alt-A", mac: "Cmd-Alt-A" },
    exec: () => this.toggleRealTimeAI()
  });

  // Setup editor change listener
  editor.on('change', (e) => {
    if (this.realTimeEnabled) {
      this.handleEditorChange(e);
    }
  });

  // Setup cursor change listener
  editor.on('changeSelection', (e) => {
    if (this.realTimeEnabled) {
      this.handleCursorChange(e);
    }
  });

  // Create suggestion widget
  this.createSuggestionWidget();
}

  toggleRealTimeAI() {
  this.realTimeEnabled = !this.realTimeEnabled;

  if (this.realTimeEnabled) {
    window.toast("Real-time Renz Ai enabled âœ¨", 3000);
    this.showRealTimeStatus(true);
    this.analyzeCurrentFile();
  } else {
    window.toast("Real-time Renz Ai disabled", 2000);
    this.showRealTimeStatus(false);
    this.clearSuggestions();
    this.clearErrorMarkers();
  }
}

showRealTimeStatus(enabled) {
  // Update UI to show real-time status
  const statusElement = document.querySelector('.realtime-ai-status') || 
    tag("div", { className: "realtime-ai-status" });

  statusElement.textContent = enabled ? "😍AI Active" : "";
  statusElement.style.cssText = `
  position: fixed;
  top: 10px;
  right: 110px;
  background: ${enabled ? 'rgba(76, 175, 80, 0.7)' : 'rgba(0,0,0,0.3)'};
  color: white;
  padding: 3px 6px; /* lebih kecil */
  border-radius: 10px;
  font-size: 10px; /* lebih kecil */
  opacity: 0.7; /* transparan */
  z-index: 1000;
  transition: all 0.3s ease;
`;

  if (enabled && !document.body.contains(statusElement)) {
    document.body.appendChild(statusElement);
  } else if (!enabled && document.body.contains(statusElement)) {
    document.body.removeChild(statusElement);
  }
}

handleEditorChange(e) {
  // Debounce untuk menghindari terlalu banyak request
  if (this.realTimeDebounceTimer) {
    clearTimeout(this.realTimeDebounceTimer);
  }

  this.realTimeDebounceTimer = setTimeout(() => {
    this.analyzeCurrentCode();
  }, this.realTimeDelay);
}

handleCursorChange(e) {
  if (this.realTimeEnabled) {
    this.showContextualSuggestions();
  }
}

async analyzeCurrentCode() {
  try {
    const activeFile = editorManager.activeFile;
    if (!activeFile) return;

    const content = editor.getValue();
    const cursorPos = editor.getCursorPosition();
    const currentLine = editor.session.getLine(cursorPos.row);

    // Skip jika konten sama dengan analisis terakhir atau perubahan terlalu kecil
    const contentDiff = this.getContentDifference(content, this.lastAnalyzedContent);
    if (content === this.lastAnalyzedContent || contentDiff < 10) return;
    this.lastAnalyzedContent = content;

    // Check cache first
    const cacheKey = this.getRealTimeCacheKey(content, cursorPos);
    const cached = this.realTimeAnalysisCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < 300000) { // 5 menit cache for better efficiency
      this.applySuggestions(cached.suggestions);
      return;
    }

    // Analyze dengan AI
    const analysis = await this.performRealTimeAnalysis(content, currentLine, cursorPos, activeFile);

    // Cache hasil
    this.realTimeAnalysisCache.set(cacheKey, {
      suggestions: analysis,
      timestamp: Date.now()
    });

    this.applySuggestions(analysis);

  } catch (error) {
    window.toast('Real-time analysis error', 3000);
  }
}

async performRealTimeAnalysis(content, currentLine, cursorPos, activeFile) {
  const fileExtension = activeFile.name.split('.').pop();
  const filePath = activeFile.uri || activeFile.name;
  const currentDir = activeFile.location || (activeFile.uri ? activeFile.uri.split('/').slice(0, -1).join('/') : '');

  // Optimized prompt for token efficiency - focus only on essential analysis
  const contextLines = content.split('\n');
  const startLine = Math.max(0, cursorPos.row - 5);
  const endLine = Math.min(contextLines.length, cursorPos.row + 5);
  const contextContent = contextLines.slice(startLine, endLine).join('\n');

  const prompt = `CODE ANALYSIS ${fileExtension} L${cursorPos.row + 1}

CONTEXT:
\`\`\`
${contextContent}
\`\`\`

RESPONSE JSON:
{
  "errors": [{"line": <num>, "msg": "<short>", "severity": "error|warning"}],
  "suggestions": [{"line": <num>, "text": "<short>", "type": "optimization|bug|style"}],
  "completions": ["<option1>", "<option2>"]
}

Focus cursor area only.`;

  try {
    const response = await this.appendGptResponse(prompt);

    // Clean the response - remove markdown wrappers if present
    let cleanResponse = response.trim();
    const jsonMatch = cleanResponse.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      cleanResponse = jsonMatch[1];
    } else if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    }

    return JSON.parse(cleanResponse);
  } catch (error) {
    // Handle AI analysis error silently and return empty result
    return {
      syntax_errors: [],
      missing_imports: [],
      code_suggestions: [],
      auto_complete: [],
      quick_fixes: []
    };
  }
}

applySuggestions(analysis) {
  // Clear previous suggestions
  this.clearSuggestions();
  this.clearErrorMarkers();

  // Apply syntax error markers
  if (analysis.syntax_errors && analysis.syntax_errors.length > 0) {
    this.showSyntaxErrors(analysis.syntax_errors);
  }

  // Show missing imports
  if (analysis.missing_imports && analysis.missing_imports.length > 0) {
    this.showMissingImports(analysis.missing_imports);
  }

  // Show code suggestions
  if (analysis.code_suggestions && analysis.code_suggestions.length > 0) {
    this.showCodeSuggestions(analysis.code_suggestions);
  }

  // Show auto-complete
  if (analysis.auto_complete && analysis.auto_complete.length > 0) {
    this.showAutoComplete(analysis.auto_complete);
  }

  // Show quick fixes
  if (analysis.quick_fixes && analysis.quick_fixes.length > 0) {
    this.showQuickFixes(analysis.quick_fixes);
  }
}

showSyntaxErrors(errors) {
  errors.forEach(error => {
    const marker = editor.session.addMarker(
      new ace.Range(error.line - 1, 0, error.line - 1, 1),
      error.severity === 'error' ? 'ace_error-marker' : 'ace_warning-marker',
      'fullLine'
    );

    this.errorMarkers.push(marker);

    // Add gutter decoration
    editor.session.setAnnotations([{
      row: error.line - 1,
      column: 0,
      text: error.message,
      type: error.severity
    }]);
  });
}

showMissingImports(imports) {
  if (imports.length === 0) return;

  const notification = tag("div", {
    className: "ai-import-suggestion",
    style: `
      position: fixed;
      top: 50px;
      right: 10px;
      background: #2196F3;
      color: white;
      padding: 10px;
      border-radius: 8px;
      max-width: 300px;
      z-index: 1000;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
    `
  });

  const title = tag("div", {
    textContent: "Missing Imports:",
    style: "font-weight: bold; margin-bottom: 5px;"
  });

  const importList = tag("div");
  imports.forEach(imp => {
    const importItem = tag("div", {
      textContent: imp,
      style: "cursor: pointer; padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.3);"
    });

    importItem.onclick = () => {
      this.addImportToFile(imp);
      document.body.removeChild(notification);
    };

    importList.appendChild(importItem);
  });

  const closeBtn = tag("button", {
    textContent: "X",
    style: `
      position: absolute;
      top: 5px;
      right: 5px;
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      font-size: 16px;
    `
  });

  closeBtn.onclick = () => {
    if (document.body.contains(notification)) {
      document.body.removeChild(notification);
    }
  };

  notification.append(title, importList, closeBtn);
  document.body.appendChild(notification);

  // Auto remove after 10 seconds
  setTimeout(() => {
    if (document.body.contains(notification)) {
      document.body.removeChild(notification);
    }
  }, 10000);
}

addImportToFile(importStatement) {
  const content = editor.getValue();
  const lines = content.split('\n');

  // Find the best position to insert import
  let insertLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('import ') || lines[i].trim().startsWith('const ') || lines[i].trim().startsWith('require(')) {
      insertLine = i + 1;
    } else if (lines[i].trim() === '') {
      continue;
    } else {
      break;
    }
  }

  // Insert import
  editor.session.insert({row: insertLine, column: 0}, importStatement + '\n');
  window.toast(`Added import: ${importStatement}`, 2000);
}

showContextualSuggestions() {
  const cursorPos = editor.getCursorPosition();
  const screenPos = editor.renderer.textToScreenCoordinates(cursorPos.row, cursorPos.column);

  if (this.currentSuggestions.length > 0) {
    this.suggestionWidget.innerHTML = '';

    this.currentSuggestions.forEach(suggestion => {
      const suggestionItem = tag("div", {
        textContent: suggestion.text || suggestion,
        style: `
          padding: 4px 8px;
          cursor: pointer;
          border-radius: 2px;
          margin: 2px 0;
        `,
        className: "suggestion-item"
      });

      suggestionItem.onmouseenter = () => {
        suggestionItem.style.background = '#333';
      };

      suggestionItem.onmouseleave = () => {
        suggestionItem.style.background = 'transparent';
      };

      suggestionItem.onclick = () => {
        this.applySuggestion(suggestion);
        this.hideSuggestionWidget();
      };

      this.suggestionWidget.appendChild(suggestionItem);
    });

    // Position widget
    this.suggestionWidget.style.left = screenPos.pageX + 'px';
    this.suggestionWidget.style.top = (screenPos.pageY + 20) + 'px';
    this.suggestionWidget.style.display = 'block';

    // Auto hide after 5 seconds
    setTimeout(() => {
      this.hideSuggestionWidget();
    }, 5000);
  }
}

hideSuggestionWidget() {
  if (this.suggestionWidget) {
    this.suggestionWidget.style.display = 'none';
  }
}

clearSuggestions() {
  this.currentSuggestions = [];
  this.hideSuggestionWidget();
}

clearErrorMarkers() {
  this.errorMarkers.forEach(marker => {
    editor.session.removeMarker(marker);
  });
  this.errorMarkers = [];
  editor.session.clearAnnotations();
}

createSuggestionWidget() {
  if (this.suggestionWidget) {
    this.suggestionWidget.remove();
  }

  this.suggestionWidget = tag("div", {
    className: "ai-suggestion-widget"
  });

  document.body.appendChild(this.suggestionWidget);
  return this.suggestionWidget;
}

showCodeSuggestions(suggestions) {
  try {
    if (!suggestions || suggestions.length === 0) {
      if (this.suggestionWidget) {
        this.suggestionWidget.style.display = 'none';
      }
      return;
    }

    if (!this.suggestionWidget) {
      this.createSuggestionWidget();
    }

    // Clear previous suggestions
    this.suggestionWidget.innerHTML = '';

    // Create header
    const header = tag("div", {
      className: "suggestion-header",
      textContent: "💡 AI Suggestions"
    });

    this.suggestionWidget.appendChild(header);

    // Create suggestion items
    suggestions.forEach((suggestion, index) => {
      const item = tag("div", {
        className: "suggestion-item"
      });

      const title = tag("div", {
        className: "suggestion-title",
        textContent: suggestion.title || `Suggestion ${index + 1}`
      });

      const description = tag("div", {
        className: "suggestion-description",
        textContent: suggestion.description || suggestion.text
      });

      item.append(title, description);

      // Add click handler
      item.addEventListener('click', () => {
        this.applySuggestion(suggestion);
        this.suggestionWidget.style.display = 'none';
      });

      this.suggestionWidget.appendChild(item);
    });

    // Position and show widget
    this.positionSuggestionWidget();
    this.suggestionWidget.style.display = 'block';

  } catch (error) {
    window.toast('Error showing code suggestions', 3000);
  }
}

showAutoComplete(completions) {
  try {
    if (!completions || completions.length === 0) {
      if (this.suggestionWidget) {
        this.suggestionWidget.style.display = 'none';
      }
      return;
    }

    if (!this.suggestionWidget) {
      this.createSuggestionWidget();
    }

    // Clear previous content
    this.suggestionWidget.innerHTML = '';

    // Create header
    const header = tag("div", {
      className: "autocomplete-header",
      textContent: "🔍 Auto Complete"
    });

    this.suggestionWidget.appendChild(header);

    // Create completion items
    completions.forEach((completion, index) => {
      const item = tag("div", {
        className: "completion-item"
      });

      // Add icon based on completion type
      const icon = tag("span", {
        className: "completion-icon",
        textContent: this.getCompletionIcon(completion.type || 'text')
      });

      const content = tag("div", {
        className: "completion-content"
      });

      const label = tag("div", {
        className: "completion-label",
        textContent: completion.label || completion.text
      });

      const detail = tag("div", {
        className: "completion-detail",
        textContent: completion.detail || completion.description || ''
      });

      content.append(label, detail);
      item.append(icon, content);

      // Add click handler
      item.addEventListener('click', () => {
        this.applyCompletion(completion);
        this.suggestionWidget.style.display = 'none';
      });

      this.suggestionWidget.appendChild(item);
    });

    // Position and show widget
    this.positionSuggestionWidget();
    this.suggestionWidget.style.display = 'block';

  } catch (error) {
    window.toast('Error showing auto complete', 3000);
  }
}

showQuickFixes(fixes) {
  try {
    if (!fixes || fixes.length === 0) {
      if (this.suggestionWidget) {
        this.suggestionWidget.style.display = 'none';
      }
      return;
    }

    if (!this.suggestionWidget) {
      this.createSuggestionWidget();
    }

    // Clear previous content
    this.suggestionWidget.innerHTML = '';

    // Create header
    const header = tag("div", {
      className: "quickfix-header",
      textContent: "🔧 Quick Fixes"
    });

    this.suggestionWidget.appendChild(header);

    // Create fix items
    fixes.forEach((fix, index) => {
      const item = tag("div", {
        className: "quickfix-item"
      });

      const fixHeader = tag("div", {
        className: "quickfix-item-header"
      });

      const severity = tag("span", {
        className: "fix-severity",
        textContent: this.getSeverityIcon(fix.severity || 'error')
      });

      const title = tag("span", {
        className: "fix-title",
        textContent: fix.title || `Fix ${index + 1}`
      });

      fixHeader.append(severity, title);

      const description = tag("div", {
        className: "fix-description",
        textContent: fix.description || fix.message
      });

      const action = tag("div", {
        className: "fix-action",
        textContent: fix.action || 'Apply Fix'
      });

      item.append(fixHeader, description, action);

      // Add click handler
      item.addEventListener('click', () => {
        this.applyQuickFix(fix);
        this.suggestionWidget.style.display = 'none';
      });

      this.suggestionWidget.appendChild(item);
    });

    // Position and show widget
    this.positionSuggestionWidget();
    this.suggestionWidget.style.display = 'block';

  } catch (error) {
    window.toast('Error showing quick fixes', 3000);
  }
}

positionSuggestionWidget() {
  if (!this.suggestionWidget || !editor) return;

  try {
    const cursorPosition = editor.getCursorPosition();
    const renderer = editor.renderer;
    const coords = renderer.textToScreenCoordinates(cursorPosition.row, cursorPosition.column);

    // Get editor container position
    const editorContainer = editor.container;
    const editorRect = editorContainer.getBoundingClientRect();

    // Calculate position relative to viewport
    const left = coords.pageX;
    const top = coords.pageY + 20; // Offset below cursor

    // Ensure widget stays within viewport
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const widgetWidth = 400;
    const widgetHeight = 300;

    let finalLeft = left;
    let finalTop = top;

    // Adjust horizontal position
    if (left + widgetWidth > viewportWidth) {
      finalLeft = viewportWidth - widgetWidth - 10;
    }

    // Adjust vertical position
    if (top + widgetHeight > viewportHeight) {
      finalTop = coords.pageY - widgetHeight - 10; // Show above cursor
    }

    this.suggestionWidget.style.left = `${Math.max(10, finalLeft)}px`;
    this.suggestionWidget.style.top = `${Math.max(10, finalTop)}px`;

  } catch (error) {
    window.toast('Error positioning suggestion widget', 3000);
    // Fallback positioning
    this.suggestionWidget.style.left = '50px';
    this.suggestionWidget.style.top = '100px';
  }
}

getCompletionIcon(type) {
  const icons = {
    'function': '🔧',
    'variable': '📦',
    'class': '🏗️',
    'method': '⚙️',
    'property': '🔗',
    'keyword': '🔑',
    'snippet': '📝',
    'text': '📄',
    'module': '📚',
    'file': '📁'
  };
  return icons[type] || '📄';
}

getSeverityIcon(severity) {
  const icons = {
    'error': '❌',
    'warning': '⚠️',
    'info': 'ℹ️',
    'hint': '💡'
  };
  return icons[severity] || '❌';
}

applySuggestion(suggestion) {
  try {
    if (!editor || !suggestion) return;

    const cursor = editor.getCursorPosition();

    if (suggestion.insertText) {
      editor.session.insert(cursor, suggestion.insertText);
    } else if (suggestion.replaceRange && suggestion.newText) {
      const range = new editor.Range(
        suggestion.replaceRange.start.row,
        suggestion.replaceRange.start.column,
        suggestion.replaceRange.end.row,
        suggestion.replaceRange.end.column
      );
      editor.session.replace(range, suggestion.newText);
    }

    // Execute any additional actions
    if (suggestion.command) {
      editor.execCommand(suggestion.command);
    }

    window.toast('Suggestion applied', 2000);

  } catch (error) {
    window.toast('Error applying suggestion', 3000);
    window.toast('Error applying suggestion', 3000);
  }
}

applyCompletion(completion) {
  try {
    if (!editor || !completion) return;

    const cursor = editor.getCursorPosition();
    const session = editor.session;

    // Get current line and determine insertion point
    const line = session.getLine(cursor.row);
    const insertText = completion.insertText || completion.label || completion.text;

    if (completion.range) {
      // Replace specific range
      const range = new editor.Range(
        completion.range.start.row,
        completion.range.start.column,
        completion.range.end.row,
        completion.range.end.column
      );
      session.replace(range, insertText);
    } else {
      // Insert at cursor position
      session.insert(cursor, insertText);
    }

    // Handle cursor positioning after insertion
    if (completion.cursorOffset) {
      const newPos = {
        row: cursor.row,
        column: cursor.column + completion.cursorOffset
      };
      editor.moveCursorToPosition(newPos);
    }

    window.toast('Completion applied', 2000);

  } catch (error) {
    window.toast('Error applying completion', 3000);
    window.toast('Error applying completion', 3000);
  }
}

applyQuickFix(fix) {
  try {
    if (!editor || !fix) return;

    // Apply text edits if provided
    if (fix.edits && Array.isArray(fix.edits)) {
      // Apply edits in reverse order to maintain positions
      const sortedEdits = fix.edits.sort((a, b) => {
        if (a.range.start.row !== b.range.start.row) {
          return b.range.start.row - a.range.start.row;
        }
        return b.range.start.column - a.range.start.column;
      });

      sortedEdits.forEach(edit => {
        const range = new editor.Range(
          edit.range.start.row,
          edit.range.start.column,
          edit.range.end.row,
          edit.range.end.column
        );
        editor.session.replace(range, edit.newText || '');
      });
    }

    // Execute command if provided
    if (fix.command) {
      if (typeof fix.command === 'string') {
        editor.execCommand(fix.command);
      } else if (fix.command.id) {
        // Handle complex command objects
        editor.execCommand(fix.command.id, fix.command.arguments);
      }
    }

    // Show success message
    window.toast(fix.successMessage || 'Quick fix applied', 2000);

    // Remove error markers if this fix resolves them
    if (fix.resolvesMarkers && this.errorMarkers) {
      fix.resolvesMarkers.forEach(markerId => {
        const markerIndex = this.errorMarkers.findIndex(m => m.id === markerId);
        if (markerIndex !== -1) {
          editor.session.removeMarker(this.errorMarkers[markerIndex].aceMarkerId);
          this.errorMarkers.splice(markerIndex, 1);
        }
      });
    }

  } catch (error) {
    window.toast('Error applying quick fix', 3000);
    window.toast('Error applying quick fix', 3000);
  }
}

async analyzeCurrentFile() {
  if (!this.realTimeEnabled) return;

  const activeFile = editorManager.activeFile;
  if (!activeFile) return;

  const content = editor.getValue();
  if (content.trim().length === 0) return;

  try {
    const analysis = await this.performRealTimeAnalysis(
      content, 
      editor.session.getLine(editor.getCursorPosition().row),
      editor.getCursorPosition(),
      activeFile
    );

    this.applySuggestions(analysis);
  } catch (error) {
    window.toast('File analysis error', 3000);
  }
}

  async destroy() {
  try {
    // Clear all intervals
    if (this.$loadInterval) {
      clearInterval(this.$loadInterval);
      this.$loadInterval = null;
    }

    // Clear real-time intervals
    if (this.realTimeInterval) {
      clearInterval(this.realTimeInterval);
      this.realTimeInterval = null;
    }

    if (this.contextUpdateInterval) {
      clearInterval(this.contextUpdateInterval);
      this.contextUpdateInterval = null;
    }

    // Safely abort ongoing requests
    try {
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
    } catch (abortError) {
      // Error aborting request
    }

    // Abort real-time requests
    if (this.realTimeAbortController) {
      this.realTimeAbortController.abort();
      this.realTimeAbortController = null;
    }

    // Close WebSocket connections
    if (this.websocket) {
      try {
        this.websocket.close();
        this.websocket = null;
      } catch (error) {
        // Error closing WebSocket
      }
    }

    // Clear EventSource connections
    if (this.eventSource) {
      try {
        this.eventSource.close();
        this.eventSource = null;
      } catch (error) {
        // Error closing EventSource
      }
    }

    // Clear message histories and real-time data
    this.messageHistories = {};
    this.messageSessionConfig = null;
    this.realTimeContext = {};
    this.contextHistory = [];
    this.realTimeEnabled = false;

    // Clear cache
    if (this.cache) {
      this.cache.clear();
    }

    // Clear real-time cache
    if (this.realTimeCache) {
      this.realTimeCache.clear();
    }

    // Safely remove event listeners
    try {
      if (this.editorChangeListener && typeof editor !== 'undefined' && editor && editor.off) {
        try {
          editor.off('change', this.editorChangeListener);
        } catch (error) {
          // Error removing editor listener
        } finally {
          this.editorChangeListener = null;
        }
      }
    } catch (error) {
      // Could not remove editor change listener
    }

    if (this.cursorChangeListener) {
      try {
        editor.off('changeSelection', this.cursorChangeListener);
        this.cursorChangeListener = null;
      } catch (error) {
        // Could not remove cursor change listener
      }
    }

    // Safely remove all commands
    if (typeof editor !== 'undefined' && editor && editor.commands && editor.commands.removeCommand) {
      const commands = [
        "ai_assistant",
        "ai_edit_current_file", 
        "ai_explain_code",
        "ai_generate_code",
        "ai_optimize_function",
        "ai_add_comments",
        "ai_generate_docs",
        "ai_rewrite_code",
        "ai_toggle_realtime",
        "ai_realtime_suggest",
        "ai_clear_realtime_context"
      ];

      commands.forEach(cmd => {
        try {
          editor.commands.removeCommand(cmd);
        } catch (error) {
          // Could not remove command
        }
      });
    }

    // Remove localStorage items including real-time settings
    const storageKeys = [
      "ai-assistant-provider",
      "ai-assistant-model-name", 
      "openai-like-baseurl",
      "Ollama-Host",
      "ai-realtime-enabled",
      "ai-realtime-interval",
      "ai-context-update-interval",
      "ai-realtime-cache-size"
    ];

    storageKeys.forEach(key => {
      window.localStorage.removeItem(key);
    });

    // Safely remove secret key file
    try {
      if (window.DATA_STORAGE && typeof fs !== 'undefined') {
        const secretKeyPath = window.DATA_STORAGE + "secret.key";
        if (await fs(secretKeyPath).exists()) {
          await fs(secretKeyPath).delete();
        }
      }
    } catch (error) {
      // Could not remove secret key file
    }

    // Remove real-time context file
    try {
      const contextPath = window.DATA_STORAGE + "realtime-context.json";
      if (await fs(contextPath).exists()) {
        await fs(contextPath).delete();
      }
    } catch (error) {
      // Could not remove real-time context file
    }

    // Remove DOM elements
    const elementsToRemove = [
      this.$githubDarkFile,
      this.$higlightJsFile, 
      this.$markdownItFile,
      this.$style,
      this.$realTimeIndicator,
      this.$contextPanel
    ];

    elementsToRemove.forEach(element => {
      try {
        if (element && element.parentNode) {
          element.remove();
        }
      } catch (error) {
        // Could not remove DOM element
      }
    });

    // Clear all references
    this.modelInstance = null;
    this.apiKeyManager = null;
    this.$page = null;
    this.realTimeManager = null;
    this.contextManager = null;

    // Clear timeouts
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = null;
    }

    if (this.contextSaveTimeout) {
      clearTimeout(this.contextSaveTimeout);
      this.contextSaveTimeout = null;
    }

    // Plugin destroyed successfully
  } catch (error) {
    window.toast("Error during plugin destruction", 3000);
  }
}

}

if (window.acode) {
  const acodePlugin = new AIAssistant();
  acode.setPluginInit(
    plugin.id,
    (baseUrl, $page, { cacheFileUrl, cacheFile }) => {
      if (!baseUrl.endsWith("/")) {
        baseUrl += "/";
      }
      acodePlugin.baseUrl = baseUrl;
      acodePlugin.init($page, cacheFile, cacheFileUrl);
    },
  );
  acode.setPluginUnmount(plugin.id, () => {
    acodePlugin.destroy();
  });
}
