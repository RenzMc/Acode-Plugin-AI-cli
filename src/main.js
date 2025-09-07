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

        if (!this.$page || !this.$page.isVisible) {
          await this.run();
        }

        if (this.$chatTextarea) {
          this.$chatTextarea.value = contextPrompt;
          this.$chatTextarea.focus();
        }
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
    searchBtn.onclick = () => {
      try {
        this.searchInChat();
      } catch (error) {
        window.toast("Search error", 3000);
      }
    };

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
      if (userCommand.includes(' ') && !userCommand.startsWith('/') && !userCommand.includes('&&') &&
        !userCommand.startsWith('ls') && !userCommand.startsWith('cd') && !userCommand.startsWith('pwd')) {
        // Looks like natural language, let AI convert it
        try {
          const aiPrompt = `Convert "${userCommand}" to safe terminal command.
Rules: No rm/delete. Dev tasks only.
Examples: "list files"→"ls -la", "show dir"→"pwd"
Reply with only the command, no explanation:`;

          // Use the actual AI API call method
          const safeCommand = await this.getAIResponse(aiPrompt);
          const cleanCommand = safeCommand.trim().replace(/[;&|`$()]/g, '').split('\n')[0];

          if (cleanCommand && !cleanCommand.includes('rm ') && !cleanCommand.includes('delete')) {
            this.executeTerminalCommand(cleanCommand);
          } else {
            window.toast("❌ Command not safe or unclear", 3000);
          }
        } catch (error) {
          window.toast("❌ AI conversion failed, executing directly", 3000);
          this.executeTerminalCommand(userCommand);
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
      try {
        const secretKeyPath = window.DATA_STORAGE + "secret.key";
        const secretKeyFs = fs(secretKeyPath);
        if (secretKeyFs && await secretKeyFs.exists()) {
          passPhrase = await secretKeyFs.readFile("utf-8");
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
      } catch (fsError) {
        window.toast("Error accessing storage", 3000);
        return;
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

      // Prevent duplicate event listeners
      if (!this.sendHandlerAttached) {
        this.sendHandler = this.sendQuery.bind(this);
        this.$sendBtn.addEventListener("click", this.sendHandler);
        this.sendHandlerAttached = true;
      }

      // Add keyboard shortcut for sending messages (prevent duplicates)
      if (!this.keydownHandlerAttached) {
        this.keydownHandler = (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this.sendQuery();
          }
        };
        this.$chatTextarea.addEventListener("keydown", this.keydownHandler);
        this.keydownHandlerAttached = true;
      }

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

          try {
            const historyFs = fs(AI_HISTORY_PATH);
            if (historyFs && !(await historyFs.exists())) {
              const storageFs = fs(window.DATA_STORAGE);
              if (storageFs) {
                await storageFs.createDirectory("cli");
              }
            }
          } catch (dirError) {
            window.toast("Error creating history directory", 3000);
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
          const sessionFs = fs(CURRENT_SESSION_FILEPATH);
          if (!sessionFs || !(await sessionFs.exists())) {
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
    try {
      const historyFs = fs(AI_HISTORY_PATH);
      if (historyFs && await historyFs.exists()) {
        const allFiles = await historyFs.lsDir();
        let elems = "";
        for (let i = 0; i < allFiles.length; i++) {
          elems += `<li class="dialog-item" style="background: var(--secondary-color);color: var(--secondary-text-color);padding: 5px;margin-bottom: 5px;border-radius: 8px;font-size:15px;display:flex;flex-direction:row;justify-content:space-between;gap:5px;" data-path="${JSON.parse(JSON.stringify(allFiles[i])).url
            }">
                  <p class="history-item">${allFiles[i].name
              .split("__")[0]
              .substring(
                0,
                25,
              )}...</p><div><button class="delete-history-btn" style="height:25px;width:25px;border:none;padding:5px;outline:none;border-radius:50%;background:var(--error-text-color);text-align:center;">✗</button></div>
                </li>`;
        }
        return elems;
      } else {
        let elems = "";
        elems = `<li style="background: var(--secondary-color);color: var(--secondary-text-color);padding: 10px;border-radius: 8px;" data-path="#not-available">Not Available</li>`;
        return elems;
      }
    } catch (error) {
      window.toast("Error loading history", 3000);
      return `<li style="background: var(--secondary-color);color: var(--secondary-text-color);padding: 10px;border-radius: 8px;" data-path="#not-available">Error Loading History</li>`;
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
    try {
      const fileFs = fs(fileUrl);
      if (!fileFs || !(await fileFs.exists())) {
        this.newChat();
        window.toast(
          "Some error occurred or file you trying to open has been deleted",
        );
        return;
      }
    } catch (error) {
      this.newChat();
      window.toast("Error accessing file", 3000);
      return;
    }

    CURRENT_SESSION_FILEPATH = fileUrl;
    try {
      historyDialogBox.hide();
      loader.create("Wait", "Fetching chat history....");
      const fileFs = fs(fileUrl);
      if (!fileFs) {
        throw new Error("Cannot access file system");
      }
      const fileData = await fileFs.readFile();
      const responses = JSON.parse(await helpers.decodeText(fileData));
      this.messageHistories = {};

      // Make sure we have the required classes available
      if (typeof InMemoryChatMessageHistory === 'undefined' ||
        typeof HumanMessage === 'undefined' ||
        typeof AIMessage === 'undefined') {
        // Use a simple array-based history fallback
        this.messageHistories[sessionId] = {
          messages: [],
          addMessages: async function (msgs) {
            this.messages.push(...msgs);
          }
        };
      } else {
        this.messageHistories[sessionId] = new InMemoryChatMessageHistory();
        let messages = responses.flatMap((pair) => [
          new HumanMessage({ content: pair.prompt }),
          new AIMessage({ content: pair.result }),
        ]);
        await this.messageHistories[sessionId].addMessages(messages);
      }
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
        if (!dialogItem) {
          return;
        }

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

          try {
            const pathValue = dialogItem.getAttribute("data-path");
            if (pathValue) {
              const fileFs = fs(pathValue);
              if (fileFs) {
                await fileFs.delete();
              }
            }
          } catch (error) {
            window.toast('Error deleting history item', 3000);
          }
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

      // Enhanced AI Agent System Prompt - Making it super advanced
      const systemPromptWithContext = `You are an ADVANCED AI AGENT for Acode mobile code editor, similar to Replit's AI Agent.

CORE CAPABILITIES:
- Execute ALL Acode commands directly from chat
- Create, edit, delete, and manage files
- Run terminal commands and scripts
- Format code, add comments, generate documentation
- Analyze project structure and dependencies
- Search and replace across entire project
- Real-time code analysis and suggestions
- File operations (move, copy, rename)
- Git operations and version control
- Package management and dependencies

CURRENT CONTEXT:
- File: ${currentFileName} (${currentFileExt})
- Location: ${currentFilePath}
- Directory: ${currentFileDir}
- Project: ${projectName}
- Cursor: Line ${cursorPos.row + 1}, Column ${cursorPos.column + 1}
- Content Length: ${editorContent.length} characters

SMART ACTION DETECTION:
When user requests actions, automatically execute them:
- "create file" → Use createFileWithAI()
- "edit/modify/change" → Use editFileContent()
- "format code" → Execute format command
- "run file" → Execute run command
- "search/find" → Use project search
- "replace" → Use search and replace
- "terminal/command" → Execute terminal commands
- "explain/analyze" → Provide detailed analysis
- "fix/debug" → Analyze and suggest fixes

RESPONSE FORMAT:
1. First, execute any requested actions automatically
2. Then provide explanation of what was done
3. Include relevant code examples when helpful
4. Always be proactive and suggest improvements

Act as a super intelligent assistant that understands context and executes actions seamlessly.`;

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

      // Enhanced AI Agent - Auto-execute detected actions
      await this.executeSmartActions(question, result);

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
    try {
      if (this.$chatBox) {
        this.$chatBox.scrollTop = this.$chatBox.scrollHeight;
      }
    } catch (error) {
      // Could not scroll chat box
    }
  }

  async loader() {
    /*
    creates proper loading dots animation
    */
    // get all ai_message elements for loader
    const loadingDots = Array.from(document.querySelectorAll(".ai_message"));
    if (loadingDots.length != 0) {
      let index = 0;
      let el = loadingDots[loadingDots.length - 1];
      let dots = ["", ".", "..", "...", ""];

      // Show proper loading dots animation
      this.$loadInterval = setInterval(() => {
        el.innerHTML = `<div style="color: var(--galaxy-star-blue); font-size: 14px; padding: 10px;">
          <span>✨ AI is thinking${dots[index]}</span>
        </div>`;
        index++;

        if (index >= dots.length) {
          index = 0;
        }
      }, 400);
    }
  }

  // Simple AI Response method for internal use (without UI updates)
  async getAIResponse(question) {
    try {
      if (!this.modelInstance) {
        throw new Error("AI model not initialized");
      }

      const systemPrompt = "You are a helpful AI assistant. Provide direct, concise answers.";
      const prompt = ChatPromptTemplate.fromMessages([
        ["system", systemPrompt],
        ["human", "{input}"],
      ]);

      const parser = new StringOutputParser();
      const chain = prompt.pipe(this.modelInstance).pipe(parser);

      const result = await chain.invoke({ input: question });
      return result;
    } catch (error) {
      console.error("AI Response Error:", error);
      throw error;
    }
  }

  // Enhanced AI Agent Methods - Smart Action Detection and Execution
  async executeSmartActions(question, aiResponse) {
    try {
      const actions = this.detectActions(question, aiResponse);
      
      for (const action of actions) {
        await this.executeAction(action);
      }
    } catch (error) {
      console.log("Smart action execution error:", error);
      // Don't show error to user as this is background enhancement
    }
  }

  detectActions(question, response) {
    const actions = [];
    const lowerQuestion = question.toLowerCase();
    const lowerResponse = response.toLowerCase();

    // File creation detection
    if (lowerQuestion.includes('create') && (lowerQuestion.includes('file') || lowerQuestion.includes('new'))) {
      actions.push({ type: 'create_file', context: question });
    }

    // Code formatting detection
    if (lowerQuestion.includes('format') || lowerQuestion.includes('beautify') || lowerQuestion.includes('pretty')) {
      actions.push({ type: 'format_code' });
    }

    // File running detection
    if (lowerQuestion.includes('run') || lowerQuestion.includes('execute') || lowerQuestion.includes('start')) {
      actions.push({ type: 'run_file' });
    }

    // Terminal command detection
    if (lowerQuestion.includes('terminal') || lowerQuestion.includes('command') || lowerQuestion.includes('shell')) {
      actions.push({ type: 'terminal_command', context: question });
    }

    // Search detection
    if (lowerQuestion.includes('search') || lowerQuestion.includes('find')) {
      actions.push({ type: 'search_project', context: question });
    }

    // Replace detection
    if (lowerQuestion.includes('replace') || lowerQuestion.includes('substitute')) {
      actions.push({ type: 'search_replace', context: question });
    }

    // Code explanation detection
    if (lowerQuestion.includes('explain') || lowerQuestion.includes('analyze') || lowerQuestion.includes('what does')) {
      actions.push({ type: 'explain_code' });
    }

    // Auto-detect code in response for file creation
    if (response.includes('```') && (lowerQuestion.includes('create') || lowerQuestion.includes('generate'))) {
      actions.push({ type: 'auto_create_file', content: response });
    }

    // Website scraping detection
    if (lowerQuestion.includes('scrape') || lowerQuestion.includes('fetch') || lowerQuestion.includes('get data from')) {
      actions.push({ type: 'scrape_website', context: question });
    }

    // Diff viewing detection
    if (lowerQuestion.includes('diff') || lowerQuestion.includes('compare') || lowerQuestion.includes('changes')) {
      actions.push({ type: 'show_diff', context: question });
    }

    // Rollback/checkpoint detection
    if (lowerQuestion.includes('rollback') || lowerQuestion.includes('undo') || lowerQuestion.includes('checkpoint') || lowerQuestion.includes('revert')) {
      actions.push({ type: 'rollback_system', context: question });
    }

    // Bulk operations detection
    if (lowerQuestion.includes('bulk') || lowerQuestion.includes('multiple files') || lowerQuestion.includes('batch')) {
      actions.push({ type: 'bulk_operations', context: question });
    }

    // Project organization detection
    if (lowerQuestion.includes('organize') || lowerQuestion.includes('structure') || lowerQuestion.includes('clean up')) {
      actions.push({ type: 'organize_project', context: question });
    }

    // General command execution detection - catch all other commands
    if (!actions.length) {
      // Look for general command keywords
      const commandIndicators = [
        'open', 'close', 'save', 'reload', 'toggle', 'show', 'hide',
        'go to', 'goto', 'settings', 'preferences', 'console', 'sidebar',
        'menu', 'file', 'edit', 'view', 'help', 'tools'
      ];
      
      if (commandIndicators.some(indicator => lowerQuestion.includes(indicator))) {
        actions.push({ type: 'execute_command', query: question });
      }
    }

    return actions;
  }

  async executeAction(action) {
    try {
      switch (action.type) {
        case 'create_file':
          await this.createFileWithAI();
          break;

        case 'format_code':
          if (editor && editor.session) {
            acode.exec('format');
            this.appendSystemMessage('✅ Code formatted successfully');
          }
          break;

        case 'run_file':
          await this.runCurrentFile();
          break;

        case 'terminal_command':
          await this.showAiTerminal();
          break;

        case 'search_project':
          await this.searchInChat();
          break;

        case 'search_replace':
          await this.showSearchReplaceDialog();
          break;

        case 'explain_code':
          const selectedText = editor.getSelectedText();
          const activeFile = editorManager.activeFile;
          if (selectedText) {
            this.explainCodeWithChat(selectedText, activeFile);
          } else if (activeFile) {
            const fullContent = editor.getValue();
            this.explainCodeWithChat(fullContent, activeFile);
          }
          break;

        case 'auto_create_file':
          await this.autoCreateFileFromResponse(action.content);
          break;

        case 'execute_command':
          await this.executeAcodeCommand(action.query);
          break;

        case 'scrape_website':
          await this.handleWebscraping(action.context);
          break;

        case 'show_diff':
          await this.handleDiffViewing(action.context);
          break;

        case 'rollback_system':
          await this.handleRollbackSystem(action.context);
          break;

        case 'bulk_operations':
          await this.bulkFileOperations();
          break;

        case 'organize_project':
          await this.organizeProjectStructure();
          break;

        default:
          break;
      }
    } catch (error) {
      console.log(`Error executing ${action.type}:`, error);
    }
  }

  async autoCreateFileFromResponse(responseContent) {
    try {
      // Extract code blocks from response
      const codeMatches = responseContent.match(/```(\w+)?\s*([\s\S]*?)\s*```/g);
      if (codeMatches && codeMatches.length > 0) {
        const firstCodeBlock = codeMatches[0];
        const languageMatch = firstCodeBlock.match(/```(\w+)/);
        const language = languageMatch ? languageMatch[1] : 'txt';
        
        // Extract clean code content
        const codeContent = firstCodeBlock.replace(/```(?:\w+)?\s*([\s\S]*?)\s*```/g, '$1').trim();
        
        if (codeContent.length > 10) { // Only create if substantial content
          // Suggest filename based on language
          const extensions = {
            javascript: '.js', js: '.js', typescript: '.ts', ts: '.ts',
            python: '.py', py: '.py', html: '.html', css: '.css',
            java: '.java', cpp: '.cpp', c: '.c', go: '.go',
            rust: '.rs', php: '.php', ruby: '.rb', swift: '.swift'
          };
          
          const ext = extensions[language] || '.txt';
          const suggestedName = `generated_file_${Date.now()}${ext}`;
          
          // Show creation dialog
          const shouldCreate = confirm(`Create file with generated ${language} code?`);
          if (shouldCreate) {
            const filename = prompt("Enter filename:", suggestedName);
            if (filename) {
              try {
                const fs = acode.require('fs');
                const currentDir = this.getCurrentDirectory();
                const targetFs = await fs(currentDir);
                await targetFs.createFile(filename, codeContent);
                
                this.appendSystemMessage(`✅ File "${filename}" created with generated code`);
                
                // Open the created file
                try {
                  const createdFileUrl = `${currentDir}/${filename}`;
                  await editorManager.openFile(createdFileUrl);
                } catch (openError) {
                  console.log("Could not open created file:", openError);
                }
              } catch (error) {
                this.appendSystemMessage(`❌ Error creating file: ${error.message}`);
              }
            }
          }
        }
      }
    } catch (error) {
      console.log("Auto create file error:", error);
    }
  }

  getCurrentDirectory() {
    const activeFile = editorManager.activeFile;
    if (activeFile && activeFile.location) {
      return activeFile.location;
    } else if (activeFile && activeFile.uri) {
      return activeFile.uri.split('/').slice(0, -1).join('/');
    }
    return '/sdcard';
  }


  // Advanced Command Execution System - Execute ALL Acode commands
  async executeAcodeCommand(commandQuery) {
    try {
      // Get all available Acode commands
      const availableCommands = this.getAllAcodeCommands();
      
      // Use AI to match the query to the best command
      const matchedCommand = await this.matchQueryToCommand(commandQuery, availableCommands);
      
      if (matchedCommand) {
        // Execute the matched command
        await this.executeCommand(matchedCommand);
        this.appendSystemMessage(`✅ Executed: ${matchedCommand.name} - ${matchedCommand.description}`);
        return true;
      } else {
        this.appendSystemMessage(`❌ Could not find command for: ${commandQuery}`);
        return false;
      }
    } catch (error) {
      this.appendSystemMessage(`❌ Error executing command: ${error.message}`);
      return false;
    }
  }

  getAllAcodeCommands() {
    const commands = [];
    
    // Get all editor commands
    if (editor && editor.commands && editor.commands.commands) {
      Object.keys(editor.commands.commands).forEach(commandName => {
        const command = editor.commands.commands[commandName];
        commands.push({
          name: commandName,
          description: command.description || commandName,
          type: 'editor',
          command: command
        });
      });
    }

    // Add custom plugin commands
    const customCommands = [
      { name: 'ai_assistant', description: 'Open AI Assistant', type: 'custom' },
      { name: 'ai_edit_current_file', description: 'Edit Current File with AI', type: 'custom' },
      { name: 'ai_explain_code', description: 'Explain Selected Code', type: 'custom' },
      { name: 'ai_generate_code', description: 'Generate Code with AI', type: 'custom' },
      { name: 'ai_run_file', description: 'Run Current File', type: 'custom' },
      { name: 'ai_optimize_function', description: 'Optimize Selected Function', type: 'custom' },
      { name: 'ai_add_comments', description: 'Add Comments to Code', type: 'custom' },
      { name: 'ai_generate_docs', description: 'Generate Documentation', type: 'custom' },
      { name: 'ai_rewrite_code', description: 'Rewrite Selected Code', type: 'custom' },
      { name: 'ai_terminal_execute', description: 'AI Terminal Command Execution', type: 'custom' },
      { name: 'ai_command_palette', description: 'AI Command Palette Control', type: 'custom' }
    ];

    commands.push(...customCommands);

    // Add common Acode commands
    const commonAcodeCommands = [
      { name: 'format', description: 'Format current file', type: 'acode' },
      { name: 'save', description: 'Save current file', type: 'acode' },
      { name: 'open', description: 'Open file', type: 'acode' },
      { name: 'new-file', description: 'Create new file', type: 'acode' },
      { name: 'console', description: 'Open console', type: 'acode' },
      { name: 'find', description: 'Find in file', type: 'acode' },
      { name: 'replace', description: 'Replace in file', type: 'acode' },
      { name: 'goto', description: 'Go to line', type: 'acode' },
      { name: 'toggle-sidebar', description: 'Toggle sidebar', type: 'acode' },
      { name: 'toggle-menu', description: 'Toggle menu', type: 'acode' },
      { name: 'reload', description: 'Reload app', type: 'acode' },
      { name: 'settings', description: 'Open settings', type: 'acode' }
    ];

    commands.push(...commonAcodeCommands);

    return commands;
  }

  async matchQueryToCommand(query, commands) {
    const lowerQuery = query.toLowerCase();
    
    // Direct name match
    let matched = commands.find(cmd => 
      cmd.name.toLowerCase() === lowerQuery ||
      cmd.description.toLowerCase().includes(lowerQuery)
    );

    if (matched) return matched;

    // Keyword matching
    const keywords = {
      'format': ['format', 'beautify', 'pretty', 'indent'],
      'save': ['save', 'write', 'store'],
      'open': ['open', 'load', 'file'],
      'find': ['find', 'search', 'locate'],
      'replace': ['replace', 'substitute', 'change'],
      'console': ['console', 'log', 'debug', 'terminal'],
      'new-file': ['new', 'create', 'file'],
      'goto': ['goto', 'go to', 'line', 'jump'],
      'toggle-sidebar': ['sidebar', 'side panel', 'navigation'],
      'settings': ['settings', 'preferences', 'config']
    };

    for (const [commandName, aliases] of Object.entries(keywords)) {
      if (aliases.some(alias => lowerQuery.includes(alias))) {
        matched = commands.find(cmd => cmd.name === commandName);
        if (matched) return matched;
      }
    }

    // AI-based matching for complex queries
    try {
      if (this.modelInstance) {
        const commandList = commands.map(cmd => `${cmd.name}: ${cmd.description}`).slice(0, 50).join('\n');
        const aiPrompt = `Match "${query}" to the best command:
${commandList}

Return only the command name or "NONE":`;

        const aiMatch = await this.getAIResponse(aiPrompt);
        const cleanMatch = aiMatch.trim().replace(/[^a-zA-Z0-9_-]/g, '');
        
        matched = commands.find(cmd => cmd.name === cleanMatch);
        if (matched) return matched;
      }
    } catch (error) {
      console.log("AI matching failed:", error);
    }

    return null;
  }

  async executeCommand(commandInfo) {
    try {
      switch (commandInfo.type) {
        case 'editor':
          if (commandInfo.command && typeof commandInfo.command.exec === 'function') {
            commandInfo.command.exec();
          }
          break;

        case 'acode':
          acode.exec(commandInfo.name);
          break;

        case 'custom':
          // Execute custom AI commands
          if (editor.commands.commands[commandInfo.name]) {
            editor.commands.commands[commandInfo.name].exec();
          }
          break;

        default:
          throw new Error(`Unknown command type: ${commandInfo.type}`);
      }
    } catch (error) {
      throw new Error(`Failed to execute ${commandInfo.name}: ${error.message}`);
    }
  }

  // Enhanced Search and Replace Dialog
  async showSearchReplaceDialog() {
    try {
      const searchTerm = await prompt("Search for:", "", "text", { required: true });
      if (!searchTerm) return;

      const replaceTerm = await prompt("Replace with:", "", "text");
      if (replaceTerm === null) return;

      // Show loading
      window.toast("🔍 Searching project files...", 2000);

      // Perform search and replace
      const result = await this.searchAndReplaceInProject(
        searchTerm, 
        replaceTerm, 
        ['.js', '.ts', '.html', '.css', '.json', '.md', '.txt'],
        {
          dryRun: false,
          caseSensitive: false
        }
      );

      if (result.success) {
        this.appendSystemMessage(`✅ ${result.message}`);
      } else {
        this.appendSystemMessage(`❌ ${result.error}`);
      }
    } catch (error) {
      this.appendSystemMessage(`❌ Search/Replace error: ${error.message}`);
    }
  }

  // ===== SUPER ADVANCED AI AGENT FEATURES =====
  // Website Scraping Capabilities
  async scrapeWebsite(url, options = {}) {
    try {
      const {
        extractText = true,
        extractLinks = false,
        extractImages = false,
        extractCode = false,
        maxLength = 50000
      } = options;

      this.appendSystemMessage(`🌐 Scraping website: ${url}`);
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/117.0 Firefox/117.0'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const scraped = {
        url: url,
        title: this.extractTitle(html),
        text: extractText ? this.extractTextContent(html) : '',
        links: extractLinks ? this.extractLinks(html, url) : [],
        images: extractImages ? this.extractImages(html, url) : [],
        code: extractCode ? this.extractCodeBlocks(html) : [],
        metadata: this.extractMetadata(html)
      };

      // Limit content length
      if (scraped.text.length > maxLength) {
        scraped.text = scraped.text.substring(0, maxLength) + '...';
      }

      this.appendSystemMessage(`✅ Successfully scraped: ${scraped.title || 'Website'}`);
      return { success: true, data: scraped };

    } catch (error) {
      this.appendSystemMessage(`❌ Scraping failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  extractTitle(html) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : 'Unknown';
  }

  extractTextContent(html) {
    // Remove scripts, styles, and other non-content elements
    let cleanHtml = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    // Extract text from common content tags
    const contentTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'article', 'section'];
    let text = '';

    contentTags.forEach(tag => {
      const regex = new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`, 'gi');
      let match;
      while ((match = regex.exec(cleanHtml)) !== null) {
        text += match[1].trim() + '\n';
      }
    });

    return text.replace(/\s+/g, ' ').trim();
  }

  extractLinks(html, baseUrl) {
    const linkRegex = /<a[^>]+href=['"]([^'"]+)['"][^>]*>([^<]*)<\/a>/gi;
    const links = [];
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      let href = match[1];
      const text = match[2].trim();

      // Convert relative URLs to absolute
      if (href.startsWith('/')) {
        const base = new URL(baseUrl);
        href = base.origin + href;
      } else if (!href.startsWith('http')) {
        href = new URL(href, baseUrl).href;
      }

      if (text && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
        links.push({ url: href, text: text });
      }
    }

    return links.slice(0, 50); // Limit to 50 links
  }

  extractImages(html, baseUrl) {
    const imgRegex = /<img[^>]+src=['"]([^'"]+)['"][^>]*(?:alt=['"]([^'"]*?)['"])?[^>]*>/gi;
    const images = [];
    let match;

    while ((match = imgRegex.exec(html)) !== null) {
      let src = match[1];
      const alt = match[2] || '';

      // Convert relative URLs to absolute
      if (src.startsWith('/')) {
        const base = new URL(baseUrl);
        src = base.origin + src;
      } else if (!src.startsWith('http') && !src.startsWith('data:')) {
        src = new URL(src, baseUrl).href;
      }

      images.push({ url: src, alt: alt });
    }

    return images.slice(0, 20); // Limit to 20 images
  }

  extractCodeBlocks(html) {
    const codeRegex = /<(?:code|pre)[^>]*>([^<]+)<\/(?:code|pre)>/gi;
    const codeBlocks = [];
    let match;

    while ((match = codeRegex.exec(html)) !== null) {
      const code = match[1].trim();
      if (code.length > 10) {
        codeBlocks.push(code);
      }
    }

    return codeBlocks.slice(0, 10); // Limit to 10 code blocks
  }

  extractMetadata(html) {
    const metadata = {};
    
    // Extract meta tags
    const metaRegex = /<meta[^>]+name=['"]([^'"]+)['"][^>]*content=['"]([^'"]+)['"][^>]*>/gi;
    let match;

    while ((match = metaRegex.exec(html)) !== null) {
      metadata[match[1]] = match[2];
    }

    // Extract Open Graph tags
    const ogRegex = /<meta[^>]+property=['"]og:([^'"]+)['"][^>]*content=['"]([^'"]+)['"][^>]*>/gi;
    while ((match = ogRegex.exec(html)) !== null) {
      metadata[`og:${match[1]}`] = match[2];
    }

    return metadata;
  }

  // Advanced Diff Viewer System
  async showAdvancedDiff(originalContent, newContent, filename) {
    try {
      const diffData = this.generateAdvancedDiff(originalContent, newContent);
      const diffHTML = this.renderDiffHTML(diffData, filename);
      
      // Create advanced diff viewer modal
      const diffModal = this.createDiffModal(diffHTML, filename);
      document.body.appendChild(diffModal);
      
      this.appendSystemMessage(`📊 Showing advanced diff for: ${filename}`);
      return { success: true, modal: diffModal };
      
    } catch (error) {
      this.appendSystemMessage(`❌ Diff error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  generateAdvancedDiff(original, modified) {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    const diffs = [];
    
    let i = 0, j = 0;
    while (i < originalLines.length || j < modifiedLines.length) {
      if (i >= originalLines.length) {
        // Remaining lines are additions
        diffs.push({ type: 'add', line: modifiedLines[j], lineNumber: j + 1 });
        j++;
      } else if (j >= modifiedLines.length) {
        // Remaining lines are deletions
        diffs.push({ type: 'delete', line: originalLines[i], lineNumber: i + 1 });
        i++;
      } else if (originalLines[i] === modifiedLines[j]) {
        // Lines are the same
        diffs.push({ type: 'unchanged', line: originalLines[i], lineNumber: i + 1 });
        i++;
        j++;
      } else {
        // Check if it's a modification or separate add/delete
        let foundMatch = false;
        for (let k = j + 1; k < Math.min(j + 5, modifiedLines.length); k++) {
          if (originalLines[i] === modifiedLines[k]) {
            // Lines between j and k are additions
            for (let l = j; l < k; l++) {
              diffs.push({ type: 'add', line: modifiedLines[l], lineNumber: l + 1 });
            }
            j = k;
            foundMatch = true;
            break;
          }
        }
        
        if (!foundMatch) {
          // It's a modification
          diffs.push({ 
            type: 'modify', 
            oldLine: originalLines[i], 
            newLine: modifiedLines[j],
            oldLineNumber: i + 1,
            newLineNumber: j + 1
          });
          i++;
          j++;
        }
      }
    }
    
    return diffs;
  }

  renderDiffHTML(diffData, filename) {
    let html = `
      <div class="advanced-diff-container">
        <div class="diff-header">
          <h3>🔍 Advanced Diff: ${filename}</h3>
          <div class="diff-stats">
            <span class="stat-additions">+${diffData.filter(d => d.type === 'add').length}</span>
            <span class="stat-deletions">-${diffData.filter(d => d.type === 'delete').length}</span>
            <span class="stat-modifications">~${diffData.filter(d => d.type === 'modify').length}</span>
          </div>
        </div>
        <div class="diff-content">
    `;

    diffData.forEach((diff, index) => {
      switch (diff.type) {
        case 'unchanged':
          html += `<div class="diff-line unchanged" data-line="${diff.lineNumber}">
            <span class="line-number">${diff.lineNumber}</span>
            <span class="line-content">${this.escapeHtml(diff.line)}</span>
          </div>`;
          break;
          
        case 'add':
          html += `<div class="diff-line addition" data-line="${diff.lineNumber}">
            <span class="line-number">+${diff.lineNumber}</span>
            <span class="line-content">${this.escapeHtml(diff.line)}</span>
          </div>`;
          break;
          
        case 'delete':
          html += `<div class="diff-line deletion" data-line="${diff.lineNumber}">
            <span class="line-number">-${diff.lineNumber}</span>
            <span class="line-content">${this.escapeHtml(diff.line)}</span>
          </div>`;
          break;
          
        case 'modify':
          html += `<div class="diff-line modification">
            <div class="old-line" data-line="${diff.oldLineNumber}">
              <span class="line-number">-${diff.oldLineNumber}</span>
              <span class="line-content">${this.escapeHtml(diff.oldLine)}</span>
            </div>
            <div class="new-line" data-line="${diff.newLineNumber}">
              <span class="line-number">+${diff.newLineNumber}</span>
              <span class="line-content">${this.escapeHtml(diff.newLine)}</span>
            </div>
          </div>`;
          break;
      }
    });

    html += `
        </div>
        <div class="diff-actions">
          <button class="diff-btn apply-changes">Apply Changes</button>
          <button class="diff-btn export-diff">Export Diff</button>
          <button class="diff-btn close-diff">Close</button>
        </div>
      </div>
    `;

    return html;
  }

  createDiffModal(diffHTML, filename) {
    const modal = tag("div", {
      className: "advanced-diff-modal",
      innerHTML: `
        <div class="diff-backdrop">
          <div class="diff-modal-content">
            ${diffHTML}
          </div>
        </div>
      `
    });

    // Add event listeners
    const closeBtn = modal.querySelector('.close-diff');
    const applyBtn = modal.querySelector('.apply-changes');
    const exportBtn = modal.querySelector('.export-diff');

    closeBtn.onclick = () => modal.remove();
    
    applyBtn.onclick = async () => {
      await this.applyDiffChanges(filename);
      modal.remove();
    };
    
    exportBtn.onclick = () => this.exportDiff(diffHTML, filename);

    // Close on backdrop click
    modal.querySelector('.diff-backdrop').onclick = (e) => {
      if (e.target === e.currentTarget) modal.remove();
    };

    return modal;
  }

  async applyDiffChanges(filename) {
    try {
      this.appendSystemMessage(`✅ Applied changes to: ${filename}`);
      window.toast(`Changes applied to ${filename}`, 3000);
    } catch (error) {
      this.appendSystemMessage(`❌ Error applying changes: ${error.message}`);
    }
  }

  exportDiff(diffHTML, filename) {
    try {
      const blob = new Blob([diffHTML], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      
      // Create temporary link to download
      const a = tag("a", {
        href: url,
        download: `${filename}_diff.html`,
        style: "display: none"
      });
      
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.appendSystemMessage(`📄 Diff exported: ${filename}_diff.html`);
    } catch (error) {
      this.appendSystemMessage(`❌ Export error: ${error.message}`);
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Comprehensive Rollback/Undo System
  async initializeRollbackSystem() {
    if (!this.rollbackManager) {
      this.rollbackManager = {
        history: [],
        currentIndex: -1,
        maxHistory: 50,
        enabled: true
      };
    }
  }

  async createCheckpoint(description, type = 'manual') {
    try {
      await this.initializeRollbackSystem();
      
      const checkpoint = {
        id: uuidv4(),
        timestamp: Date.now(),
        description: description,
        type: type,
        files: await this.captureProjectState(),
        editorState: this.captureEditorState()
      };

      // Remove any history after current index (if we've rolled back)
      this.rollbackManager.history = this.rollbackManager.history.slice(0, this.rollbackManager.currentIndex + 1);
      
      // Add new checkpoint
      this.rollbackManager.history.push(checkpoint);
      this.rollbackManager.currentIndex++;

      // Limit history size
      if (this.rollbackManager.history.length > this.rollbackManager.maxHistory) {
        this.rollbackManager.history.shift();
        this.rollbackManager.currentIndex--;
      }

      this.appendSystemMessage(`💾 Checkpoint created: ${description}`);
      return { success: true, checkpointId: checkpoint.id };
      
    } catch (error) {
      this.appendSystemMessage(`❌ Checkpoint error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async captureProjectState() {
    const projectState = {};
    
    try {
      // Get all project files
      const allFiles = await this.getAllProjectFiles();
      
      for (const filePath of allFiles.slice(0, 20)) { // Limit to 20 files for performance
        try {
          const readResult = await this.readFileContent(filePath);
          if (readResult.success) {
            projectState[filePath] = {
              content: readResult.content,
              lastModified: Date.now()
            };
          }
        } catch (error) {
          // Skip files that can't be read
        }
      }
    } catch (error) {
      console.log("Error capturing project state:", error);
    }
    
    return projectState;
  }

  captureEditorState() {
    try {
      const activeFile = editorManager.activeFile;
      if (!activeFile || !editor) return null;

      return {
        activeFile: activeFile.uri || activeFile.name,
        cursorPosition: editor.getCursorPosition(),
        selection: editor.getSelectedText(),
        scrollPosition: editor.renderer.getScrollTop()
      };
    } catch (error) {
      return null;
    }
  }

  async showRollbackHistory() {
    try {
      await this.initializeRollbackSystem();
      
      if (this.rollbackManager.history.length === 0) {
        this.appendSystemMessage("📂 No rollback history available");
        return;
      }

      const historyItems = this.rollbackManager.history.map((checkpoint, index) => {
        const date = new Date(checkpoint.timestamp).toLocaleString();
        const isCurrent = index === this.rollbackManager.currentIndex;
        return `${isCurrent ? '➤ ' : '  '}${index + 1}. ${checkpoint.description} (${date})`;
      }).join('\n');

      const selectedIndex = await prompt(
        `Rollback History:\n\n${historyItems}\n\nEnter checkpoint number to rollback to:`,
        '',
        'number'
      );

      if (selectedIndex && selectedIndex > 0 && selectedIndex <= this.rollbackManager.history.length) {
        await this.rollbackToCheckpoint(selectedIndex - 1);
      }
      
    } catch (error) {
      this.appendSystemMessage(`❌ Rollback history error: ${error.message}`);
    }
  }

  async rollbackToCheckpoint(checkpointIndex) {
    try {
      const checkpoint = this.rollbackManager.history[checkpointIndex];
      if (!checkpoint) {
        throw new Error('Checkpoint not found');
      }

      this.appendSystemMessage(`🔄 Rolling back to: ${checkpoint.description}`);
      
      // Restore files
      for (const [filePath, fileState] of Object.entries(checkpoint.files)) {
        try {
          await this.editFileContent(filePath, fileState.content);
        } catch (error) {
          console.log(`Error restoring file ${filePath}:`, error);
        }
      }

      // Restore editor state
      if (checkpoint.editorState) {
        await this.restoreEditorState(checkpoint.editorState);
      }

      this.rollbackManager.currentIndex = checkpointIndex;
      this.appendSystemMessage(`✅ Successfully rolled back to: ${checkpoint.description}`);
      
      return { success: true };
      
    } catch (error) {
      this.appendSystemMessage(`❌ Rollback error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async restoreEditorState(editorState) {
    try {
      if (editorState.activeFile) {
        // Try to open the file that was active
        try {
          await editorManager.openFile(editorState.activeFile);
        } catch (error) {
          // File might not exist anymore
        }
      }

      if (editor && editorState.cursorPosition) {
        editor.moveCursorToPosition(editorState.cursorPosition);
      }

      if (editor && editorState.scrollPosition) {
        editor.renderer.scrollToY(editorState.scrollPosition);
      }
      
    } catch (error) {
      console.log("Error restoring editor state:", error);
    }
  }

  // Handler methods for advanced AI actions
  async handleWebscraping(context) {
    try {
      // Extract URL from context
      const urlMatch = context.match(/https?:\/\/[^\s]+/i);
      if (!urlMatch) {
        const url = await prompt("Enter website URL to scrape:", "https://", "text", { required: true });
        if (!url) return;
        
        const result = await this.scrapeWebsite(url, {
          extractText: true,
          extractLinks: true,
          extractCode: true
        });
        
        if (result.success) {
          const summary = `**Website: ${result.data.title}**\n\n**Content Preview:**\n${result.data.text.substring(0, 500)}...\n\n**Found ${result.data.links.length} links and ${result.data.code.length} code blocks**`;
          this.appendUserQuery(`Website scraping result for: ${url}`);
          this.appendGptResponse(summary);
        }
      } else {
        const url = urlMatch[0];
        const result = await this.scrapeWebsite(url, {
          extractText: true,
          extractLinks: true,
          extractCode: true
        });
        
        if (result.success) {
          const summary = `**Website: ${result.data.title}**\n\n**Content Preview:**\n${result.data.text.substring(0, 500)}...\n\n**Found ${result.data.links.length} links and ${result.data.code.length} code blocks**`;
          this.appendGptResponse(summary);
        }
      }
    } catch (error) {
      this.appendSystemMessage(`❌ Webscraping error: ${error.message}`);
    }
  }

  async handleDiffViewing(context) {
    try {
      const activeFile = editorManager.activeFile;
      if (!activeFile) {
        this.appendSystemMessage("❌ No active file to show diff");
        return;
      }

      // Get current content
      const currentContent = editor.getValue();
      
      // For demo, compare with a previous version (in real scenario, this would come from version control)
      const previousContent = await prompt(
        "Enter previous version content for comparison (or paste content):",
        "",
        "textarea"
      );
      
      if (previousContent !== null) {
        await this.showAdvancedDiff(previousContent, currentContent, activeFile.name);
      }
    } catch (error) {
      this.appendSystemMessage(`❌ Diff viewing error: ${error.message}`);
    }
  }

  async handleRollbackSystem(context) {
    try {
      const lowerContext = context.toLowerCase();
      
      if (lowerContext.includes('create') || lowerContext.includes('checkpoint')) {
        // Create checkpoint
        const description = await prompt("Enter checkpoint description:", "Manual checkpoint", "text");
        if (description) {
          await this.createCheckpoint(description, 'manual');
        }
      } else if (lowerContext.includes('show') || lowerContext.includes('list') || lowerContext.includes('history')) {
        // Show rollback history
        await this.showRollbackHistory();
      } else {
        // Default to showing options
        const action = await select("Rollback System", [
          "Create Checkpoint",
          "Show History",
          "Rollback to Previous"
        ]);
        
        switch (action) {
          case "Create Checkpoint":
            const description = await prompt("Enter checkpoint description:", "Manual checkpoint", "text");
            if (description) {
              await this.createCheckpoint(description, 'manual');
            }
            break;
          case "Show History":
            await this.showRollbackHistory();
            break;
          case "Rollback to Previous":
            await this.initializeRollbackSystem();
            if (this.rollbackManager.currentIndex > 0) {
              await this.rollbackToCheckpoint(this.rollbackManager.currentIndex - 1);
            } else {
              this.appendSystemMessage("❌ No previous checkpoint available");
            }
            break;
        }
      }
    } catch (error) {
      this.appendSystemMessage(`❌ Rollback system error: ${error.message}`);
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

      const response = await this.getAIResponse(aiPrompt);

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
        if (!suggestion.filename || suggestion.content === undefined) {
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
          const content = confirmCreate.content || suggestion.content;
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
              }
            }

            // **PERBAIKAN UTAMA: Gunakan fs API yang benar**
            const fs = acode.require('fs'); // Import fs module
            const targetFs = await fs(finalTargetDir); // Create filesystem object

            // Ensure content is not empty
            const finalContent = content || suggestion.content || '';

            // Create file using the correct API
            const createdFileUrl = await targetFs.createFile(fileName, finalContent);

            // Show success message with full path information
            window.toast(`✅ File created successfully!\n📁 ${createdFileUrl}`, 4000);

            // Close the AI assistant page if it's open
            if (this.$page && this.$page.isVisible) {
              this.$page.hide();
            }

            // **PERBAIKAN: Gunakan EditorFile API yang benar**
            try {
              // Method 1: Try to open existing file
              await editorManager.openFile(createdFileUrl);
            } catch (error) {
              // Method 2: Create new EditorFile using the correct API
              const EditorFile = acode.require('editorFile');
              const newFile = new EditorFile(fileName, {
                text: finalContent,
                uri: createdFileUrl,
                render: true,
                isUnsaved: false
              });

              // Make the file active
              newFile.makeActive();
            }

          } catch (error) {
            const errorMessage = error && error.message ? error.message : 'Unknown error occurred';
            window.toast(`❌ Error creating file: ${errorMessage}`, 4000);

            const EditorFile = acode.require('editorFile');
            const newFile = new EditorFile(fileName, {
              text: content || suggestion.content || '',
              render: true,
              isUnsaved: true // Mark as unsaved since it's only in memory
            });

            newFile.makeActive();
            window.toast(`📝 File created in memory: ${fileName}`, 3000);
          }
        }

      } catch (parseError) {
        // Handle parsing error - create file with raw content
        console.warn('JSON parsing failed, using raw content:', parseError);

        // Extract code blocks if JSON parsing fails
        const codeMatch = response.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
        const extractedContent = codeMatch ? codeMatch[1] : response;

        // Fallback to manual filename input
        const filename = await prompt("Enter filename for the generated content:", "", "text", {
          required: true
        });

        if (filename) {
          try {
            const fs = acode.require('fs');

            // Try to use basePath or current working directory
            let targetDirectory = basePath || workingDir;

            // Allow user to select directory
            try {
              const fileBrowser = acode.require('fileBrowser');
              const dirResult = await fileBrowser('folder', `Save ${filename} to folder:`);
              if (dirResult && dirResult.url) {
                targetDirectory = dirResult.url;
              }
            } catch (browserError) {
              // User cancelled, use default directory
            }

            const targetFs = await fs(targetDirectory);
            const createdFileUrl = await targetFs.createFile(filename, extractedContent);

            window.toast(`✅ File created: ${filename}`, 3000);

            // Close the AI assistant page if it's open
            if (this.$page && this.$page.isVisible) {
              this.$page.hide();
            }

            // Open the created file
            try {
              await editorManager.openFile(createdFileUrl);
            } catch (openError) {
              const EditorFile = acode.require('editorFile');
              const newFile = new EditorFile(filename, {
                text: extractedContent,
                uri: createdFileUrl,
                render: true,
                isUnsaved: false
              });
              newFile.makeActive();
            }

          } catch (fsError) {
            console.warn('Filesystem operation failed, creating in memory:', fsError);

            // **ULTIMATE FALLBACK: Create file in memory only**
            const EditorFile = acode.require('editorFile');
            const newFile = new EditorFile(filename, {
              text: extractedContent,
              render: true,
              isUnsaved: true,
              editable: true
            });

            newFile.makeActive();
            window.toast(`📝 File created in memory: ${filename}\n💾 Use Save As to save to device`, 4000);
          }
        }
      }

    } catch (error) {
      loader.removeTitleLoader();
      console.error('AI file creation error:', error);
      window.toast(`❌ Failed to create file with AI: ${error.message}`, 4000);
    }
  }

  async renameFileIntelligently(filePath) {
    try {
      // Menggunakan fs API yang benar
      const filesystem = await acode.require('fs')(filePath);

      if (!await filesystem.exists()) {
        throw new Error("File not found");
      }

      const content = await filesystem.readFile('utf8');
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
        // Menggunakan renameTo method yang tersedia di API
        const newUrl = await filesystem.renameTo(selectedName);
        window.toast(`File renamed to: ${selectedName}`, 3000);

        // Update editor jika file sedang terbuka
        // Menggunakan editorManager yang benar dari Acode
        const openFiles = editorManager.files;
        const openFile = openFiles.find(file => file.uri === filePath);

        if (openFile) {
          // Update properti file yang terbuka
          openFile.filename = selectedName;
          openFile.uri = newUrl;

          // Refresh tab jika diperlukan
          if (openFile.tab) {
            openFile.tab.textContent = selectedName;
          }
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

      // Enhanced validation for ACODE
      if (!projectFiles || !Array.isArray(projectFiles) || projectFiles.length === 0) {
        loader.removeTitleLoader();
        window.toast("No project files found to organize", 3000);
        return;
      }

      // Safe slice operation with validation
      let filesToShow;
      try {
        filesToShow = projectFiles.slice(0, 20);
      } catch (sliceError) {
        loader.removeTitleLoader();
        window.toast(`Error processing files: ${sliceError.message}`, 3000);
        return;
      }

      // Build file list safely
      const fileList = filesToShow
        .filter(f => f && f.name) // Filter out invalid entries
        .map(f => `- ${f.name} (${f.type || 'unknown'})`)
        .join('\n');

      if (fileList.length === 0) {
        loader.removeTitleLoader();
        window.toast("No valid files found in project structure", 3000);
        return;
      }

      const aiPrompt = `Project structure analysis for organization:

Files found: ${projectFiles.length}
${fileList}

Suggest improvements:
1. Better folder organization
2. Files to move/group
3. New directories needed
4. Cleanup recommendations

Response format: Clear actionable steps.`;

      const response = await this.getAIResponse(aiPrompt);
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
      const fs = acode.require('fs'); // ✅ Import fs module sesuai dokumentasi
      const allFiles = [];

      const scanDir = async (dirPath, depth = 0) => {
        if (depth > 3) return; // Limit depth

        try {
          const filesystem = await fs(dirPath); // ✅ Create filesystem object

          if (await filesystem.exists()) {
            const entries = await filesystem.lsDir(); // ✅ Use lsDir() method

            for (const entry of entries) {
              if (entry.isDirectory && !entry.name.startsWith('.')) {
                // Add folder info
                allFiles.push({
                  name: entry.name,
                  type: 'folder',
                  path: `${dirPath}/${entry.name}`,
                  size: 0
                });

                // Recursively scan subdirectory
                await scanDir(`${dirPath}/${entry.name}`, depth + 1);
              } else if (entry.isFile) {
                // Add file info
                allFiles.push({
                  name: entry.name,
                  type: 'file',
                  path: `${dirPath}/${entry.name}`,
                  size: entry.size || 0,
                  extension: entry.name.split('.').pop() || 'unknown'
                });
              }
            }
          }
        } catch (error) {
          console.warn(`Error scanning directory ${dirPath}:`, error);
        }
      };

      // Start scanning from current working directory or default path
      const startPath = window.PLUGIN_DIR || '/sdcard';
      await scanDir(startPath);

      this.projectStructure = allFiles;
      this.lastStructureScan = Date.now();

      return allFiles;
    } catch (error) {
      console.error('Error scanning project structure:', error);
      window.toast('Error scanning project structure', 3000);
      return [];
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
      const fileBrowser = acode.require('fileBrowser');
      const fs = acode.require('fs');

      const folderResult = await fileBrowser('folder', 'Select folder containing files to rename');
      if (!folderResult) {
        window.toast("No folder selected", 3000);
        return;
      }

      const folderPath = folderResult.url;
      const folderFs = await fs(folderPath);
      const entries = await folderFs.lsDir();

      const files = entries.filter(entry => !entry.isDirectory).map(entry => `${folderPath}/${entry.name}`);

      if (!files.length) {
        window.toast("No files found in selected folder", 3000);
        return;
      }

      window.toast(`Found ${files.length} files in folder`, 2000);

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
              const baseName = pattern.replace('{index}', i + 1);
              const newName = baseName.replace(/\.[^.]*$/, '') + extension;

              await fileFs.renameTo(newName);
              renamedCount++;
            }
          } catch (err) {
            window.toast(`Error renaming file ${i + 1}: ${err.message}`, 3000);
          }
        }

        loader.removeTitleLoader();
        window.toast(`✅ Renamed ${renamedCount} files successfully`, 4000);

        try {
          const openFolder = acode.require('openFolder');
          if (openFolder.find && openFolder.find(folderPath)) {
            openFolder.find(folderPath).reload();
          }
        } catch (e) {
          // Silent fail - folder refresh is optional
        }
      }
    } catch (error) {
      loader.removeTitleLoader();
      window.toast(`❌ Bulk rename error: ${error.message}`, 3000);
    }
  }

  async bulkMoveFiles() {
    try {
      const fileBrowser = acode.require('fileBrowser');
      const fs = acode.require('fs');

      const files = await this.selectMultipleFiles();
      if (!files.length) {
        window.toast("No files selected", 3000);
        return;
      }

      const targetResult = await fileBrowser('folder', 'Select target folder for files');
      if (!targetResult) {
        window.toast("No target folder selected", 3000);
        return;
      }

      const targetFolder = targetResult.url;

      try {
        const targetFs = await fs(targetFolder);
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
            const fileFs = await fs(filePath);
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
      const fileBrowser = acode.require('fileBrowser');
      const fs = acode.require('fs');

      const folderResult = await fileBrowser('folder', 'Select project folder to scan for unused files');
      if (!folderResult) {
        window.toast("No folder selected", 3000);
        return;
      }

      const projectPath = folderResult.url;
      loader.showTitleLoader();

      const allFiles = await this.getAllFilesRecursive(projectPath);

      const codeFiles = allFiles.filter(file =>
        /\.(js|jsx|ts|tsx|vue|html|css|scss|sass|less)$/i.test(file)
      );

      const assetFiles = allFiles.filter(file =>
        /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp3|mp4|avi|mov|pdf|doc|docx)$/i.test(file)
      );

      if (assetFiles.length === 0) {
        loader.removeTitleLoader();
        window.toast("No asset files found to check", 3000);
        return;
      }

      const unusedFiles = [];

      for (const assetFile of assetFiles) {
        const fileName = assetFile.split('/').pop();
        const fileNameWithoutExt = fileName.replace(/\.[^.]*$/, '');
        let isUsed = false;

        for (const codeFile of codeFiles) {
          try {
            const codeFs = await fs(codeFile);
            const content = await codeFs.readFile('utf8');

            const patterns = [
              fileName,
              fileNameWithoutExt,
              assetFile.replace(projectPath, ''),
              assetFile.split('/').slice(-2).join('/')
            ];

            if (patterns.some(pattern => content.includes(pattern))) {
              isUsed = true;
              break;
            }
          } catch (err) {
            continue;
          }
        }

        if (!isUsed) {
          unusedFiles.push(assetFile);
        }
      }

      loader.removeTitleLoader();

      if (unusedFiles.length === 0) {
        window.toast("✅ No unused files found!", 3000);
        return;
      }

      const fileList = unusedFiles.map(file => file.split('/').pop()).join('\n');
      const confirmDelete = await select(
        `Found ${unusedFiles.length} potentially unused files:\n\n${fileList.substring(0, 200)}${fileList.length > 200 ? '...' : ''}\n\nDelete these files?`,
        ["Yes", "No", "Show List"]
      );

      if (confirmDelete === "Show List") {
        const EditorFile = acode.require('editorFile');
        const listContent = `Unused Files Found:\n\n${unusedFiles.map((file, index) => `${index + 1}. ${file}`).join('\n')}`;

        new EditorFile('unused_files_list.txt', {
          text: listContent,
          render: true
        });
        return;
      }

      if (confirmDelete === "Yes") {
        loader.showTitleLoader();
        let deletedCount = 0;

        for (const filePath of unusedFiles) {
          try {
            const fileFs = await fs(filePath);
            if (await fileFs.exists()) {
              await fileFs.delete();
              deletedCount++;
            }
          } catch (err) {
            window.toast(`Error deleting file: ${err.message}`, 3000);
          }
        }

        loader.removeTitleLoader();
        window.toast(`✅ Deleted ${deletedCount} unused files`, 4000);

        try {
          const openFolder = acode.require('openFolder');
          if (openFolder.find && openFolder.find(projectPath)) {
            openFolder.find(projectPath).reload();
          }
        } catch (e) {
          // Silent fail
        }
      }

    } catch (error) {
      loader.removeTitleLoader();
      window.toast(`❌ Delete unused files error: ${error.message}`, 3000);
    }
  }

  async getAllFilesRecursive(dirPath) {
    const fs = acode.require('fs');
    const allFiles = [];

    try {
      const dirFs = await fs(dirPath);
      const entries = await dirFs.lsDir();

      for (const entry of entries) {
        const fullPath = `${dirPath}/${entry.name}`;

        if (entry.isDirectory) {
          if (!['node_modules', '.git', 'dist', 'build', '.cache'].includes(entry.name)) {
            const subFiles = await this.getAllFilesRecursive(fullPath);
            allFiles.push(...subFiles);
          }
        } else {
          allFiles.push(fullPath);
        }
      }
    } catch (err) {
      // Silent fail for inaccessible directories
    }

    return allFiles;
  }

  async addHeadersToFiles() {
    try {
      const fs = acode.require('fs');

      const cfg = await multiPrompt("File Header Configuration", [
        {
          id: "header",
          placeholder: "Header template (use {filename}, {date}, {author}, {year}, {time})",
          value: "/*\n * File: {filename}\n * Created: {date}\n * Author: {author}\n */\n",
          type: "textarea",
          required: true
        },
        { id: "author", placeholder: "Author name", value: "Developer", type: "text" },
        { id: "extensions", placeholder: "File extensions (e.g., .js,.css,.html)", value: ".js,.css,.html", type: "text", required: true },
        { id: "include", placeholder: "Include glob (comma separated, optional)", value: "", type: "text" },
        { id: "exclude", placeholder: "Exclude glob (comma separated, optional)", value: "node_modules,.git", type: "text" },
        { id: "maxSizeKB", placeholder: "Max file size (KB) to process (0 = no limit)", value: "0", type: "text" },
      ]);

      if (!cfg) return;

      const insertPos = await select("Insert header:", ["Top of file", "After shebang (#!)", "After existing license/header if present"]);
      const makeBackup = await select("Create backups (.bak)?", ["Yes", "No"]);
      const dryRun = await select("Dry run (don't write files)?", ["Yes", "No"]);
      const confirmApply = await select("Start adding headers now?", ["Yes", "No"]);

      if (confirmApply !== "Yes") {
        window.toast("Cancelled", 2000);
        return;
      }

      const author = cfg.author || "Developer";
      const extList = cfg.extensions.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).map(e => e.startsWith('.') ? e : '.' + e);
      const includeGlobs = cfg.include ? cfg.include.split(',').map(s => s.trim()).filter(Boolean) : [];
      const excludeGlobs = cfg.exclude ? cfg.exclude.split(',').map(s => s.trim()).filter(Boolean) : [];
      const maxSizeKB = Number(cfg.maxSizeKB || 0);

      const matchAny = (name, patterns) => {
        if (!patterns || !patterns.length) return false;
        return patterns.some(p => {
          if (p === name) return true;
          if (p.startsWith('*') && name.endsWith(p.slice(1))) return true;
          if (p.endsWith('*') && name.startsWith(p.slice(0, -1))) return true;
          return name.includes(p);
        });
      };

      const formatHeader = (template, fileName) => {
        const d = new Date();
        const placeholders = {
          '{filename}': fileName,
          '{date}': d.toLocaleDateString(),
          '{time}': d.toLocaleTimeString(),
          '{year}': String(d.getFullYear()),
          '{author}': author
        };
        let out = template;
        for (const k in placeholders) out = out.split(k).join(placeholders[k]);
        return out;
      };

      let files = [];
      if (typeof this.getAllProjectFiles === 'function') {
        try {
          files = await this.getAllProjectFiles(extList);
        } catch (e) {
          console.warn('getAllProjectFiles failed, falling back to internal walker', e);
        }
      }

      if (!files || !files.length) {
        const root = window.PLUGIN_DIR || '/sdcard';
        const MAX_DEPTH = 6;
        const walker = async (dirPath, depth = 0) => {
          if (depth > MAX_DEPTH) return;
          try {
            const dirFs = await fs(dirPath);
            if (!dirFs || !await dirFs.exists()) return;
            let items = [];
            try {
              items = await dirFs.lsDir();
            } catch (e) {
              console.warn('lsDir fail', dirPath, e);
              return;
            }
            for (const item of items) {
              const name = item.name || item.filename || item.path || String(item);
              if (!name) continue;
              if (excludeGlobs.length && matchAny(name, excludeGlobs)) continue;
              const childPath = dirPath.endsWith('/') ? dirPath + name : dirPath + '/' + name;
              const isDir = ('isDirectory' in item) ? item.isDirectory : (item.isFile === false);
              if (isDir) {
                if (['node_modules', '.git', 'dist', 'build'].includes(name)) continue;
                await walker(childPath, depth + 1);
              } else {
                const ext = (name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '');
                if (extList.length && !extList.includes(ext)) continue;
                if (includeGlobs.length && !matchAny(name, includeGlobs)) continue;
                files.push(childPath);
              }
            }
          } catch (err) {
            console.warn('walker error', dirPath, err);
          }
        };
        await walker(root, 0);
      }

      if (!files.length) {
        window.toast("No matching files found", 3000);
        return;
      }

      let processedCount = 0, skippedCount = 0, errors = 0, backups = 0;
      const summary = { processed: [], skipped: [], errors: [] };

      const normalizeForCompare = s => (s || '').replace(/\r\n/g, '\n').trim();

      for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        try {
          const f = await fs(filePath);
          if (!f || !await f.exists()) {
            skippedCount++;
            summary.skipped.push({ file: filePath, reason: 'not exists' });
            continue;
          }

          let fileSize = 0;
          try {
            const st = await f.stat();
            fileSize = st && st.size ? Number(st.size) : 0;
          } catch (e) { /* ignore stat errors */ }

          if (maxSizeKB > 0 && fileSize > maxSizeKB * 1024) {
            skippedCount++;
            summary.skipped.push({ file: filePath, reason: 'size limit' });
            continue;
          }

          let content = '';
          try {
            content = await f.readFile('utf8');
          } catch (e) {
            skippedCount++;
            summary.skipped.push({ file: filePath, reason: 'read error' });
            continue;
          }

          if (typeof content === 'string' && content.indexOf('\0') !== -1) {
            skippedCount++;
            summary.skipped.push({ file: filePath, reason: 'binary' });
            continue;
          }

          const fileName = filePath.split('/').pop();
          const headerText = formatHeader(cfg.header, fileName);
          const headerNormalized = normalizeForCompare(headerText);

          const contentNormalizedStart = normalizeForCompare(content.slice(0, headerText.length + 200));
          let alreadyHas = false;

          if (contentNormalizedStart.startsWith(headerNormalized) || normalizeForCompare(content).startsWith(headerNormalized)) {
            alreadyHas = true;
          } else {
            const topChunk = content.slice(0, 500);
            const authorRegex = new RegExp(author.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
            if (topChunk.includes('Author:') && authorRegex.test(topChunk)) alreadyHas = true;
          }

          if (alreadyHas) {
            skippedCount++;
            summary.skipped.push({ file: filePath, reason: 'already has header' });
            continue;
          }

          let newContent = content;
          if (insertPos === "After shebang (#!)") {
            if (content.startsWith('#!')) {
              const idx = content.indexOf('\n');
              if (idx === -1) newContent = content + '\n' + headerText;
              else newContent = content.slice(0, idx + 1) + headerText + content.slice(idx + 1);
            } else {
              newContent = headerText + content;
            }
          } else if (insertPos === "After existing license/header if present") {
            const lines = content.split(/\r?\n/);
            let insertAt = 0;
            while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
            if (lines[insertAt] && lines[insertAt].startsWith('#!')) {
              insertAt++;
            }
            if (lines[insertAt] && lines[insertAt].trim().startsWith('/*')) {
              let j = insertAt;
              while (j < lines.length && !lines[j].includes('*/')) j++;
              insertAt = j + 1;
            } else {
              let j = insertAt;
              while (j < lines.length && (lines[j].trim().startsWith('//') || lines[j].trim().startsWith('#') || lines[j].trim() === '')) j++;
              insertAt = j;
            }
            const before = lines.slice(0, insertAt).join('\n');
            const after = lines.slice(insertAt).join('\n');
            newContent = (before ? before + '\n' : '') + headerText + (after ? after : '');
          } else {
            newContent = headerText + content;
          }

          if (makeBackup === "Yes") {
            try {
              const bakPath = filePath + `.bak.${Date.now()}`;
              const bakFs = await fs(bakPath);
              await bakFs.writeFile(content, 'utf8');
              backups++;
            } catch (e) {
              console.warn('backup failed for', filePath, e);
            }
          }

          if (dryRun !== "Yes") {
            try {
              await f.writeFile(newContent, 'utf8');
              processedCount++;
              summary.processed.push(filePath);
            } catch (e) {
              errors++;
              summary.errors.push({ file: filePath, error: e && e.message ? e.message : String(e) });
              console.warn('writeFile error', filePath, e);
            }
          } else {
            processedCount++;
            summary.processed.push(filePath);
          }

          if ((i % 25) === 0) window.toast(`Processing ${i + 1}/${files.length}...`, 1000);

        } catch (errFile) {
          errors++;
          summary.errors.push({ file: filePath, error: errFile && errFile.message ? errFile.message : String(errFile) });
          console.warn('file loop error', filePath, errFile);
        }
      }

      const msg = `Headers: processed ${processedCount}, skipped ${skippedCount}, errors ${errors}, backups ${backups}`;
      window.toast(msg, 4000);

      return { processedCount, skippedCount, errors, backups, details: summary };

    } catch (error) {
      window.toast(`Add headers error: ${error && error.message ? error.message : String(error)}`, 5000);
      return { processedCount: 0, skippedCount: 0, errors: 1, backups: 0, error: error };
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
            // Baca file menggunakan API acodeplugin
            const readResult = await this.readFileContent(filePath);
            if (readResult.success) {
              const baseName = filePath.replace(conversion.fromExt, '');
              const newPath = baseName + conversion.toExt;

              // Buat file baru dengan ekstensi yang dikonversi
              const createResult = await this.createFileInProject(newPath, readResult.content);
              if (createResult.success) {
                // Hapus file asli
                const deleteResult = await this.deleteFileFromProject(filePath);
                if (deleteResult.success) {
                  convertedCount++;
                }
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
      const selectedFiles = [];
      let continueSelection = true;
      let selectionCount = 0;

      // Dapatkan semua file project terlebih dahulu
      const allFiles = await this.getAllProjectFiles();

      if (allFiles.length === 0) {
        window.toast("No files found in project", 3000);
        return [];
      }

      // Buat daftar file untuk dipilih
      const fileOptions = allFiles.map(filePath => {
        const fileName = filePath.split('/').pop();
        return `${fileName} (${filePath})`;
      });

      while (continueSelection && selectionCount < 10) {
        try {
          const selectedOption = await select(`Select files (${selectionCount} selected)`, [...fileOptions, "Done"]);

          if (selectedOption === "Done" || !selectedOption) {
            continueSelection = false;
          } else {
            // Extract file path dari option yang dipilih
            const filePath = selectedOption.match(/\((.*)\)$/)?.[1];
            if (filePath && !selectedFiles.includes(filePath)) {
              selectedFiles.push(filePath);
              selectionCount++;

              // Remove selected file dari options
              const index = fileOptions.indexOf(selectedOption);
              if (index > -1) {
                fileOptions.splice(index, 1);
              }

              if (fileOptions.length === 0) {
                continueSelection = false;
              }
            }
          }
        } catch (error) {
          continueSelection = false;
        }
      }

      return selectedFiles;
    } catch (error) {
      window.toast(`Error selecting files: ${error.message}`, 3000);
      return [];
    }
  }

  async readFileContent(filePath) {
    try {
      const fsModule = acode.require('fs');
      const fileFs = fsModule(filePath);

      if (fileFs && await fileFs.exists()) {
        const content = await fileFs.readFile('utf8');
        return { success: true, content, path: filePath };
      } else {
        return { success: false, error: `File not found: ${filePath}` };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async editFileContent(filePath, newContent) {
    try {
      const fsModule = acode.require('fs');
      const fileFs = fsModule(filePath);

      if (!fileFs) {
        throw new Error("Cannot access file system");
      }

      // Buat backup sebelum edit
      if (await fileFs.exists()) {
        const originalContent = await fileFs.readFile('utf8');

        // Simpan info undo
        this.storeUndoInfo(filePath, originalContent);

        // Tulis konten baru
        await fileFs.writeFile(newContent);

        // Update editor yang sedang aktif jika file sedang terbuka
        const editorManager = acode.require('editorManager');
        const activeFile = editorManager.activeFile;

        if (activeFile && (activeFile.uri === filePath || activeFile.location + '/' + activeFile.filename === filePath)) {
          activeFile.session.setValue(newContent);
          activeFile.isUnsaved = false;
        }
      } else {
        // File tidak ada, buat file baru
        const createResult = await this.createFileInProject(filePath, newContent);
        if (!createResult.success) {
          throw new Error(createResult.error);
        }
      }

      return { success: true, message: `File edited successfully: ${filePath.split('/').pop()}` };
    } catch (error) {
      window.toast('Error editing file content', 3000);
      return { success: false, error: error.message };
    }
  }

  async createFileInProject(filePath, content = '') {
    try {
      const fsModule = acode.require('fs');
      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      const fileName = filePath.split('/').pop();

      // Pastikan parent directory ada
      const parentFs = fsModule(parentDir);
      if (!await parentFs.exists()) {
        // Buat directory jika tidak ada
        await parentFs.createDirectory();
      }

      // Buat file
      await parentFs.createFile(fileName, content);

      return { success: true, message: `File created successfully: ${fileName}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteFileFromProject(filePath) {
    try {
      const fsModule = acode.require('fs');
      const fileFs = fsModule(filePath);

      if (fileFs && await fileFs.exists()) {
        // Buat backup sebelum hapus
        const content = await fileFs.readFile('utf8');
        const backupInfo = {
          path: filePath,
          content: content,
          timestamp: Date.now()
        };

        // Simpan backup info untuk recovery
        this.storeDeletedFileInfo(backupInfo);

        await fileFs.delete();
        return { success: true, message: `File deleted successfully: ${filePath}` };
      } else {
        return { success: false, error: `File not found: ${filePath}` };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async showFileDiff(originalContent, newContent, filename) {
    try {
      const originalLines = originalContent.split('\n');
      const newLines = newContent.split('\n');

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

      const maxLines = Math.max(originalLines.length, newLines.length);
      let hasChanges = false;

      for (let i = 0; i < maxLines; i++) {
        const origLine = originalLines[i] || '';
        const newLine = newLines[i] || '';

        if (origLine !== newLine) {
          hasChanges = true;

          if (origLine && newLine) {
            // Modified line
            diffHtml += `<div class="diff-line modified">
            <span class="line-num">${i + 1}</span>
            <span class="old-line">- ${origLine}</span>
            <span class="new-line">+ ${newLine}</span>
          </div>`;
          } else if (origLine && !newLine) {
            // Deleted line
            diffHtml += `<div class="diff-line deleted">
            <span class="line-num">${i + 1}</span>
            <span class="old-line">- ${origLine}</span>
          </div>`;
          } else if (!origLine && newLine) {
            // Added line
            diffHtml += `<div class="diff-line added">
            <span class="line-num">${i + 1}</span>
            <span class="new-line">+ ${newLine}</span>
          </div>`;
          }
        } else {
          // Unchanged line
          diffHtml += `<div class="diff-line unchanged">
          <span class="line-num">${i + 1}</span>
          <span class="unchanged-line">${origLine}</span>
        </div>`;
        }
      }

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

  async searchAndReplaceInProject(searchTerm, replaceTerm, fileExtensions = ['.js', '.json', '.html', '.css', '.md'], options = {}) {
    const {
      dryRun = false,
      useRegex = false,
      caseSensitive = true,
      maxFileSize = 10 * 1024 * 1024,
      excludePatterns = ['node_modules', '.git', 'dist', 'build', '.cache'],
      includeHidden = false,
      backupFiles = false,
      progressCallback = null
    } = options;

    const fsModule = acode.require('fs');
    const startTime = Date.now();

    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const metrics = {
      filesScanned: 0,
      filesProcessed: 0,
      bytesProcessed: 0,
      timeElapsed: 0,
      averageFileSize: 0
    };

    try {
      // Validasi input
      if (!searchTerm || typeof searchTerm !== 'string' || searchTerm.trim().length === 0) {
        return {
          success: false,
          error: '🚫 Search term must be a non-empty string',
          code: 'INVALID_SEARCH_TERM'
        };
      }

      if (typeof replaceTerm !== 'string') {
        return {
          success: false,
          error: '🚫 Replace term must be a string',
          code: 'INVALID_REPLACE_TERM'
        };
      }

      // Buat pattern regex
      let flags = 'g';
      if (!caseSensitive) flags += 'i';
      let pattern;

      try {
        if (useRegex) {
          if (searchTerm.length > 1000) {
            throw new Error('Regex pattern too complex (max 1000 characters)');
          }
          pattern = new RegExp(searchTerm, flags);
        } else {
          pattern = new RegExp(escapeRegExp(searchTerm), flags);
        }
        pattern.test('');
      } catch (e) {
        return {
          success: false,
          error: `🔴 Invalid regex pattern: ${e.message}`,
          code: 'REGEX_ERROR'
        };
      }

      // Dapatkan semua file project
      const projectFiles = await this.getAllProjectFiles(fileExtensions);

      if (!projectFiles || projectFiles.length === 0) {
        return {
          success: true,
          results: [],
          message: '📂 No project files found matching the specified criteria.',
          metrics: { ...metrics, timeElapsed: Date.now() - startTime },
          summary: { filesScanned: 0, matchingFiles: 0, totalOccurrences: 0 }
        };
      }

      // Proses search & replace
      const results = [];
      let totalReplacements = 0;
      let skippedFiles = 0;

      window.toast(`🚀 Processing ${projectFiles.length} files...`, 2000);

      for (let i = 0; i < projectFiles.length; i++) {
        const filePath = projectFiles[i];
        metrics.filesScanned++;

        if (progressCallback && i % 10 === 0) {
          progressCallback({
            phase: 'processing',
            current: i + 1,
            total: projectFiles.length,
            currentFile: filePath,
            matches: totalReplacements
          });
        }

        try {
          // Baca file menggunakan API acodeplugin
          const readResult = await this.readFileContent(filePath);

          if (!readResult.success) {
            results.push({
              file: filePath,
              error: readResult.error,
              skipped: true
            });
            skippedFiles++;
            continue;
          }

          const content = readResult.content;
          const fileSize = content.length;
          metrics.bytesProcessed += fileSize;

          // Deteksi file binary
          const nullBytes = (content.match(/\0/g) || []).length;
          const nonPrintable = (content.match(/[\x00-\x08\x0E-\x1F\x7F]/g) || []).length;
          const binaryRatio = (nullBytes + nonPrintable) / content.length;

          if (binaryRatio > 0.1 || nullBytes > 10) {
            skippedFiles++;
            continue;
          }

          // Cek apakah ada match
          pattern.lastIndex = 0;
          if (!pattern.test(content)) continue;

          // Analisis match detail
          pattern.lastIndex = 0;
          const matches = [];
          let match;
          while ((match = pattern.exec(content)) !== null) {
            matches.push({
              text: match[0],
              index: match.index,
              line: content.substring(0, match.index).split('\n').length
            });
            if (!pattern.global) break;
          }

          const occurrences = matches.length;

          // Replace content
          pattern.lastIndex = 0;
          const newContent = content.replace(pattern, replaceTerm);

          // Tulis file jika bukan dry run
          if (!dryRun) {
            const editResult = await this.editFileContent(filePath, newContent);
            if (!editResult.success) {
              results.push({
                file: filePath,
                occurrences,
                matches: matches.slice(0, 5),
                updated: false,
                error: editResult.error,
                fileSize: Math.round(fileSize / 1024) + 'KB'
              });
              continue;
            }
            metrics.filesProcessed++;
          }

          totalReplacements += occurrences;
          results.push({
            file: filePath,
            occurrences,
            matches: matches.slice(0, 5),
            updated: !dryRun,
            fileSize: Math.round(fileSize / 1024) + 'KB',
            encoding: 'utf8'
          });

        } catch (errFile) {
          results.push({
            file: filePath,
            error: errFile?.message || String(errFile),
            skipped: true
          });
          skippedFiles++;
        }
      }

      // Hitung metrics final
      metrics.timeElapsed = Date.now() - startTime;
      metrics.averageFileSize = metrics.filesScanned > 0 ?
        Math.round(metrics.bytesProcessed / metrics.filesScanned) : 0;

      const successfulFiles = results.filter(r => r.updated).length;
      const matchingFiles = results.filter(r => r.occurrences > 0).length;

      const message = dryRun
        ? `🔍 Dry Run Complete: Found ${matchingFiles} files with matches (${totalReplacements} occurrences). No files were modified. ${skippedFiles} files skipped.`
        : `✅ Operation Complete: Replaced "${searchTerm}" with "${replaceTerm}" in ${successfulFiles}/${matchingFiles} files (${totalReplacements} total occurrences). ${skippedFiles} files skipped.`;

      window.toast(message, 5000);

      return {
        success: true,
        results,
        totalOccurrences: totalReplacements,
        message,
        metrics: {
          ...metrics,
          skippedFiles,
          successRate: metrics.filesScanned > 0 ?
            Math.round((metrics.filesProcessed / metrics.filesScanned) * 100) : 0
        },
        summary: {
          filesScanned: metrics.filesScanned,
          matchingFiles,
          successfulReplacements: successfulFiles,
          totalOccurrences: totalReplacements,
          processingTime: `${(metrics.timeElapsed / 1000).toFixed(2)}s`,
          averageSpeed: metrics.timeElapsed > 0 ?
            Math.round(metrics.filesScanned / (metrics.timeElapsed / 1000)) + ' files/sec' : 'N/A'
        },
        options: { dryRun, useRegex, caseSensitive, maxFileSize, excludePatterns }
      };

    } catch (error) {
      const errorMsg = `🔴 Critical error: ${error?.message || String(error)}`;
      window.toast(errorMsg, 6000);

      return {
        success: false,
        error: errorMsg,
        code: 'CRITICAL_ERROR',
        metrics: { ...metrics, timeElapsed: Date.now() - startTime }
      };
    }
  }

  async getAllProjectFiles(extensions = []) {
    try {
      const fileList = acode.require('fileList');
      const openFolders = await fileList();
      let allFiles = [];

      if (openFolders.length > 0) {
        // Gunakan folder yang terbuka sebagai root directory
        for (const folder of openFolders) {
          const folderFiles = await this.getAllFilesRecursive(folder.url);
          allFiles.push(...folderFiles);
        }
      } else {
        // Fallback ke directory default
        const defaultPath = window.PLUGIN_DIR || '/sdcard';
        allFiles = await this.getAllFilesRecursive(defaultPath);
      }

      // Filter berdasarkan ekstensi jika disediakan
      if (extensions.length > 0) {
        const normalizedExts = extensions.map(ext =>
          ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase()
        );

        allFiles = allFiles.filter(filePath => {
          const fileName = filePath.split('/').pop();
          const fileExt = fileName.includes('.') ? '.' + fileName.split('.').pop().toLowerCase() : '';
          return normalizedExts.includes(fileExt);
        });
      }

      return allFiles;
    } catch (error) {
      window.toast(`Error getting project files: ${error.message}`, 3000);
      return [];
    }
  }

  // Helper methods untuk backup dan undo
  storeUndoInfo(filePath, originalContent) {
    if (!this.undoHistory) this.undoHistory = [];
    this.undoHistory.push({
      path: filePath,
      content: originalContent,
      timestamp: Date.now()
    });

    // Batasi history ke 10 item terakhir
    if (this.undoHistory.length > 10) {
      this.undoHistory.shift();
    }
  }

  storeDeletedFileInfo(backupInfo) {
    if (!this.deletedFiles) this.deletedFiles = [];
    this.deletedFiles.push(backupInfo);

    // Batasi ke 20 file yang dihapus terakhir
    if (this.deletedFiles.length > 20) {
      this.deletedFiles.shift();
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

      // Enhanced regex patterns for different languages and frameworks
      const patterns = [
        // JavaScript/TypeScript imports
        /(?:import.*from\s+['"`]([^'"`]+)['"`]|require\(['"`]([^'"`]+)['"`]\))/g,
        // CSS @import
        /@import\s+['"`]([^'"`]+)['"`]/g,
        // SCSS/SASS @import and @use
        /@(?:import|use)\s+['"`]([^'"`]+)['"`]/g,
        // HTML script/link src
        /(?:src|href)\s*=\s*['"`]([^'"`]+)['"`]/g,
        // Vue/Angular template imports
        /(?:from|import)\s+['"`]([^'"`]+)['"`]/g,
        // Python imports (for .py files)
        /(?:from\s+([^\s]+)\s+import|import\s+([^\s]+))/g,
        // PHP includes/requires
        /(?:include|require)(?:_once)?\s*\(?['"`]([^'"`]+)['"`]\)?/g,
        // Go imports
        /import\s+['"`]([^'"`]+)['"`]/g,
        // Rust use statements
        /use\s+([^;]+);/g,
        // C/C++ includes
        /#include\s*[<"]([^>"]+)[>"]/g
      ];

      // Apply all patterns
      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const importPath = match[1] || match[2];
          if (importPath &&
            !importPath.startsWith('http') &&
            !importPath.startsWith('//') &&
            !importPath.includes('node_modules') &&
            !importPath.includes('vendor/') &&
            !this.isSystemImport(importPath)) {
            imports.push(importPath);
          }
        }
      });

      const relatedFiles = [];
      const basePath = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));

      for (const importPath of imports) {
        let resolvedPath = this.resolveImportPath(importPath, basePath);

        // Try different extensions based on file type
        const extensions = this.getExtensionsForFile(currentFilePath);
        let found = false;

        for (const ext of extensions) {
          const fullPath = resolvedPath + ext;
          try {
            if (await fs(fullPath).exists()) {
              const fileContent = await fs(fullPath).readFile('utf8');
              relatedFiles.push({
                path: fullPath,
                content: fileContent,
                extension: ext || this.getFileExtension(fullPath)
              });
              found = true;
              break;
            }
          } catch (error) {
            continue;
          }
        }

        // If not found, try as directory with index files
        if (!found) {
          const indexFiles = await this.tryIndexFiles(resolvedPath);
          if (indexFiles.length > 0) {
            relatedFiles.push(...indexFiles);
          }
        }
      }

      return { success: true, files: relatedFiles, imports };
    } catch (error) {
      window.toast('Error reading related files', 3000);
      return { success: false, error: error.message };
    }
  }

  // Helper method to check if import is a system/built-in import
  isSystemImport(importPath) {
    const systemPatterns = [
      // Node.js built-ins
      /^(fs|path|http|https|url|crypto|os|util|events|stream|buffer|child_process|cluster|dgram|dns|net|readline|repl|tls|tty|v8|vm|worker_threads|zlib)$/,
      // Python built-ins
      /^(sys|os|json|re|math|datetime|collections|itertools|functools|operator|pathlib|urllib|http|xml|csv|sqlite3|threading|multiprocessing|asyncio|typing)$/,
      // Go standard library
      /^(fmt|log|net|http|json|time|strings|strconv|io|os|path|regexp|sync|context|crypto|encoding|database|testing)$/,
      // C/C++ standard library
      /^(stdio|stdlib|string|math|time|ctype|limits|float|stdarg|setjmp|signal|locale|errno|assert|stddef|stdint|stdbool|complex|fenv|inttypes|iso646|stdalign|stdatomic|stdnoreturn|tgmath|threads|uchar|wchar|wctype)$/
    ];

    return systemPatterns.some(pattern => pattern.test(importPath));
  }

  // Helper method to resolve import paths
  resolveImportPath(importPath, basePath) {
    if (importPath.startsWith('./')) {
      return `${basePath}/${importPath.substring(2)}`;
    } else if (importPath.startsWith('../')) {
      const upLevels = (importPath.match(/\.\.\//g) || []).length;
      let parentPath = basePath;

      for (let i = 0; i < upLevels; i++) {
        const lastSlash = parentPath.lastIndexOf('/');
        if (lastSlash > 0) {
          parentPath = parentPath.substring(0, lastSlash);
        }
      }

      const remainingPath = importPath.replace(/\.\.\//g, '');
      return `${parentPath}/${remainingPath}`;
    } else if (importPath.startsWith('/')) {
      return importPath;
    } else {
      return `${basePath}/${importPath}`;
    }
  }

  // Helper method to get appropriate extensions based on current file
  getExtensionsForFile(filePath) {
    const currentExt = this.getFileExtension(filePath);

    const extensionMap = {
      // JavaScript/TypeScript
      'js': ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json'],
      'jsx': ['', '.jsx', '.js', '.ts', '.tsx', '.json'],
      'ts': ['', '.ts', '.tsx', '.js', '.jsx', '.d.ts', '.json'],
      'tsx': ['', '.tsx', '.ts', '.jsx', '.js', '.json'],
      'mjs': ['', '.mjs', '.js', '.json'],
      'cjs': ['', '.cjs', '.js', '.json'],

      // Vue
      'vue': ['', '.vue', '.js', '.ts', '.jsx', '.tsx', '.json'],

      // CSS/SCSS/SASS
      'css': ['', '.css', '.scss', '.sass', '.less', '.styl'],
      'scss': ['', '.scss', '.sass', '.css'],
      'sass': ['', '.sass', '.scss', '.css'],
      'less': ['', '.less', '.css'],
      'styl': ['', '.styl', '.css'],

      // HTML
      'html': ['', '.html', '.htm', '.xhtml', '.php', '.jsp', '.asp'],
      'htm': ['', '.htm', '.html'],

      // PHP
      'php': ['', '.php', '.phtml', '.php3', '.php4', '.php5', '.phps'],

      // Python
      'py': ['', '.py', '.pyx', '.pyi', '.pyw'],
      'pyx': ['', '.pyx', '.py'],

      // Go
      'go': ['', '.go'],

      // Rust
      'rs': ['', '.rs'],

      // C/C++
      'c': ['', '.c', '.h'],
      'cpp': ['', '.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.h'],
      'h': ['', '.h', '.hpp', '.hh'],

      // Java
      'java': ['', '.java'],

      // C#
      'cs': ['', '.cs'],

      // Ruby
      'rb': ['', '.rb', '.rbw'],

      // Swift
      'swift': ['', '.swift'],

      // Kotlin
      'kt': ['', '.kt', '.kts'],

      // Dart
      'dart': ['', '.dart'],

      // Markdown
      'md': ['', '.md', '.markdown', '.mdown', '.mkd'],

      // Config files
      'json': ['', '.json', '.jsonc'],
      'yaml': ['', '.yaml', '.yml'],
      'yml': ['', '.yml', '.yaml'],
      'toml': ['', '.toml'],
      'ini': ['', '.ini', '.cfg', '.conf'],
      'xml': ['', '.xml', '.xsd', '.xsl', '.xslt'],

      // Shell scripts
      'sh': ['', '.sh', '.bash', '.zsh', '.fish'],
      'bash': ['', '.bash', '.sh'],

      // PowerShell
      'ps1': ['', '.ps1', '.psm1', '.psd1'],

      // Batch
      'bat': ['', '.bat', '.cmd'],

      // Default fallback
      'default': ['', '.js', '.ts', '.json', '.css', '.html', '.md', '.txt']
    };

    return extensionMap[currentExt] || extensionMap['default'];
  }

  // Helper method to get file extension
  getFileExtension(filePath) {
    const lastDot = filePath.lastIndexOf('.');
    const lastSlash = filePath.lastIndexOf('/');

    if (lastDot > lastSlash && lastDot !== -1) {
      return filePath.substring(lastDot + 1).toLowerCase();
    }
    return '';
  }

  // Helper method to try index files in directories
  async tryIndexFiles(dirPath) {
    const indexNames = [
      'index.js', 'index.ts', 'index.jsx', 'index.tsx', 'index.vue',
      'index.html', 'index.php', 'index.py', '__init__.py',
      'main.js', 'main.ts', 'app.js', 'app.ts',
      'mod.rs', 'lib.rs' // Rust
    ];

    const foundFiles = [];

    for (const indexName of indexNames) {
      const indexPath = `${dirPath}/${indexName}`;
      try {
        if (await fs(indexPath).exists()) {
          const content = await fs(indexPath).readFile('utf8');
          foundFiles.push({
            path: indexPath,
            content: content,
            extension: this.getFileExtension(indexPath)
          });
          break; // Only take the first found index file
        }
      } catch (error) {
        continue;
      }
    }

    return foundFiles;
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
      // Create search dialog
      const searchDialog = this.createSearchDialog();
      document.body.appendChild(searchDialog);

      // Focus on search input
      const searchInput = searchDialog.querySelector('#ai-search-input');
      setTimeout(() => searchInput.focus(), 100);

      // Handle search dialog events
      const result = await new Promise((resolve) => {
        const handleSearch = async () => {
          const searchTerm = searchInput.value.trim();
          if (!searchTerm) {
            searchInput.focus();
            return;
          }

          const options = {
            searchTerm,
            scope: searchDialog.querySelector('#ai-search-scope').value,
            caseSensitive: searchDialog.querySelector('#ai-case-sensitive').checked,
            wholeWord: searchDialog.querySelector('#ai-whole-word').checked,
            sessionId: searchDialog.querySelector('#ai-session-list').value
          };

          document.body.removeChild(searchDialog);
          resolve(options);
        };

        const handleCancel = () => {
          document.body.removeChild(searchDialog);
          resolve(null);
        };

        // Event listeners
        searchDialog.querySelector('#ai-search-submit').addEventListener('click', handleSearch);
        searchDialog.querySelector('#ai-search-cancel').addEventListener('click', handleCancel);
        searchDialog.querySelector('.ai-search-close').addEventListener('click', handleCancel);
        searchDialog.querySelector('#ai-search-clear').addEventListener('click', () => {
          searchInput.value = '';
          searchInput.focus();
        });

        // Scope change handler
        searchDialog.querySelector('#ai-search-scope').addEventListener('change', async (e) => {
          const sessionSelector = searchDialog.querySelector('#ai-session-selector');
          const sessionList = searchDialog.querySelector('#ai-session-list');

          if (e.target.value === 'session') {
            // Populate session list
            sessionList.innerHTML = '<option value="">Select session...</option>';
            if (this.messageHistories) {
              Object.keys(this.messageHistories).forEach(sessionId => {
                const option = document.createElement('option');
                option.value = sessionId;
                option.textContent = `Session: ${sessionId.substring(0, 8)}...`;
                sessionList.appendChild(option);
              });
            }
            sessionSelector.style.display = 'block';
          } else {
            sessionSelector.style.display = 'none';
          }
        });

        // Enter to search, Escape to cancel
        searchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') handleSearch();
          if (e.key === 'Escape') handleCancel();
        });

        // Click overlay to close
        searchDialog.addEventListener('click', (e) => {
          if (e.target === searchDialog) handleCancel();
        });
      });

      if (!result) return;

      // Perform search based on scope
      let searchResults = [];

      if (result.scope === 'current') {
        searchResults = this.searchCurrentChat(result);
      } else if (result.scope === 'all') {
        searchResults = this.searchAllHistory(result);
      } else if (result.scope === 'session') {
        searchResults = this.searchSpecificSession(result);
      }

      // Display results
      if (searchResults.length === 0) {
        window.toast && window.toast(`🔍 No results found for "${result.searchTerm}"`, 3000);
        return;
      }

      // Show results dialog
      this.showSearchResults(searchResults, result.searchTerm);

    } catch (error) {
      console.error("Search error:", error);
      window.toast && window.toast("❌ Error searching chat", 3000);
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

      // Get current timestamp for filename
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const fileName = `ai-chat-conversation-${timestamp}.md`;

      let exportText = `# AI Chat Conversation\n`;
      exportText += `**Exported:** ${new Date().toLocaleString()}\n`;
      exportText += `**Provider:** ${localStorage.getItem('ai-assistant-provider') || 'Unknown'}\n`;
      exportText += `**Model:** ${localStorage.getItem('ai-assistant-model-name') || 'Unknown'}\n\n`;
      exportText += `---\n\n`;

      chatMessages.forEach((wrapper, index) => {
        const isUser = wrapper.classList.contains('wrapper');
        const message = wrapper.querySelector('.message, .ai_message');
        const text = message ? message.textContent.trim() : '';

        if (text) {
          const speaker = isUser ? '👤 **User**' : '🤖 **AI Assistant**';
          exportText += `${speaker}\n\n${text}\n\n---\n\n`;
        }
      });

      exportText += `\n\n*Exported from Acode AI Assistant Plugin at ${new Date().toLocaleString()}*`;

      // Use Acode file system to save the file
      try {
        const fileBrowser = acode.require('fileBrowser');
        const result = await fileBrowser('folder', 'Select folder to save conversation');

        if (result && result.url) {
          const targetFs = fs(result.url);
          await targetFs.createFile(fileName, exportText);
          window.toast(`💾 Conversation exported to ${result.name}/${fileName}`, 4000);
        } else {
          // Fallback to default location
          const defaultPath = window.DATA_STORAGE || '/sdcard';
          const defaultFs = fs(defaultPath);
          await defaultFs.createFile(fileName, exportText);
          window.toast(`💾 Conversation exported to ${defaultPath}/${fileName}`, 4000);
        }
      } catch (fileError) {
        // Fallback to browser download if file system fails
        const blob = new Blob([exportText], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        window.toast("📁 Conversation downloaded to browser downloads", 3000);
      }

    } catch (error) {
      console.error('Export error:', error);
      window.toast(`❌ Export failed: ${error.message}`, 3000);
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
    // helper creator: pakai tag() kalau ada, kalau nggak fallback ke createElement
    const maker = (tagName, props = {}) => {
      if (typeof tag === "function") return tag(tagName, props);
      const el = document.createElement(tagName);
      Object.assign(el, props);
      return el;
    };

    const container = document.getElementById("acode-ai-assistant") || document.body;

    // build elements
    const backdrop = maker("div", { className: "ai-edit-backdrop" });
    const popup = maker("div", { className: "ai-edit-popup" });

    const header = maker("div", { className: "ai-edit-popup-header" });
    const title = maker("div", {
      className: "ai-edit-popup-title",
      textContent: "Edit with AI"
    });
    const closeBtn = maker("button", {
      className: "ai-edit-popup-close",
      innerHTML: "&times;",
      title: "Close"
    });

    header.append(title, closeBtn);

    const body = maker("div", { className: "ai-edit-popup-body" });
    const promptArea = maker("textarea", {
      className: "ai-edit-prompt",
      placeholder:
        "Describe what you want to do with the code...\nExample: 'Add error handling to this function' or 'Optimize this loop for better performance'",
      value: initialText
    });

    const actions = maker("div", { className: "ai-edit-actions" });
    const cancelBtn = maker("button", {
      className: "ai-edit-btn secondary",
      textContent: "Cancel"
    });
    const editBtn = maker("button", {
      className: "ai-edit-btn primary",
      textContent: "Edit Code"
    });

    actions.append(cancelBtn, editBtn);
    body.append(promptArea, actions);
    popup.append(header, body);
    backdrop.appendChild(popup);

    // stop clicks inside popup from closing via backdrop
    popup.addEventListener("click", (e) => e.stopPropagation());

    // append into scoped container (so SCSS under #acode-ai-assistant apply)
    container.appendChild(backdrop);

    // focus safely
    setTimeout(() => {
      try {
        promptArea.focus({ preventScroll: true });
      } catch (err) {
        promptArea.focus();
      }
      if (initialText) {
        try {
          const len = initialText.length;
          promptArea.setSelectionRange(len, len);
        } catch (e) {
          // ignore if not supported
        }
      }
    }, 60);

    const cleanup = () => {
      try {
        if (container.contains(backdrop)) container.removeChild(backdrop);
      } catch (e) { }
      // remove listeners
      document.removeEventListener("keydown", handleKeyDown);
      backdrop.removeEventListener("click", onBackdropClick);
      closeBtn.removeEventListener("click", onClose);
      cancelBtn.removeEventListener("click", onClose);
      editBtn.removeEventListener("click", onEdit);
      promptArea.removeEventListener("keydown", promptKeydown);
      popup.removeEventListener("click", (ev) => ev.stopPropagation()); // safe noop
    };

    const onClose = () => cleanup();

    const onBackdropClick = (e) => {
      if (e.target === backdrop) onClose();
    };

    const promptKeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        editBtn.click();
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const onEdit = async () => {
      const prompt = (promptArea.value || "").trim();
      if (!prompt) {
        if (window && typeof window.toast === "function") {
          window.toast("Please enter editing instructions", 3000);
        } else {
          console.warn("Please enter editing instructions");
        }
        try { promptArea.focus(); } catch (e) { }
        return;
      }
      // close UI then process
      cleanup();
      try {
        await this.processAiEdit(prompt);
      } catch (err) {
        console.error("processAiEdit error:", err);
        window && typeof window.toast === "function" && window.toast("Error processing edit", 3000);
      }
    };

    // wire listeners
    closeBtn.addEventListener("click", onClose);
    cancelBtn.addEventListener("click", onClose);
    editBtn.addEventListener("click", onEdit);
    promptArea.addEventListener("keydown", promptKeydown);
    backdrop.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", handleKeyDown);
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
        try {
          await this.explainCodeWithChat(selectedText, activeFile);
        } catch (error) {
          window.toast('Error explaining code: ' + (error.message || 'Unknown error'), 3000);
        }
        break;
      case "Rewrite":
        try {
          await this.rewriteCodeWithChat(selectedText);
        } catch (error) {
          window.toast('Error rewriting code: ' + (error.message || 'Unknown error'), 3000);
        }
        break;
      case "Generate Code":
        try {
          await this.showGenerateCodePopup();
        } catch (error) {
          window.toast('Error generating code: ' + (error.message || 'Unknown error'), 3000);
        }
        break;
      case "Optimize Function":
        try {
          await this.optimizeFunctionWithChat(selectedText);
        } catch (error) {
          window.toast('Error optimizing code: ' + (error.message || 'Unknown error'), 3000);
        }
        break;
      case "Add Comments":
        try {
          await this.addCommentsWithChat(selectedText);
        } catch (error) {
          window.toast('Error adding comments: ' + (error.message || 'Unknown error'), 3000);
        }
        break;
      case "Generate Docs":
        try {
          await this.generateDocsWithChat(selectedText);
        } catch (error) {
          window.toast('Error generating docs: ' + (error.message || 'Unknown error'), 3000);
        }
        break;
      case "Edit with AI":
        try {
          this.showAiEditPopup();
        } catch (error) {
          window.toast('Error showing AI edit popup: ' + (error.message || 'Unknown error'), 3000);
        }
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
    // Gunakan tag helper dari Acode untuk membuat elemen
    const tag = acode.require('tag');

    // Cari container utama plugin (fall back ke body)
    const container = document.getElementById("acode-ai-assistant") || document.body;

    // Buat backdrop + popup
    const backdrop = tag("div", { className: "ai-edit-backdrop" });
    const popup = tag("div", { className: "ai-edit-popup" });

    // Header
    const header = tag("div", { className: "ai-edit-popup-header" });
    const title = tag("div", {
      className: "ai-edit-popup-title",
      textContent: "Generate Code"
    });
    const closeBtn = tag("button", {
      className: "ai-edit-popup-close",
      innerHTML: "×",
      title: "Close"
    });
    header.append(title, closeBtn);

    // Body
    const body = tag("div", { className: "ai-edit-popup-body" });
    const promptArea = tag("textarea", {
      className: "ai-edit-prompt",
      placeholder: "Describe what code you want to generate...\nExample: 'Create a function to validate email addresses'"
    });

    // Actions
    const actions = tag("div", { className: "ai-edit-actions" });
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
    backdrop.appendChild(popup);

    // Append to container
    container.appendChild(backdrop);

    // Focus dengan mencegah scroll
    try {
      promptArea.focus({ preventScroll: true });
    } catch (e) {
      promptArea.focus();
    }

    // --- Handlers (disposable so we can remove them on close) ---
    const removePopup = () => {
      // Safe remove
      if (container.contains(backdrop)) container.removeChild(backdrop);

      // Cleanup listeners
      promptArea.removeEventListener("keydown", promptKeydown);
      generateBtn.removeEventListener("click", onGenerate);
      closeBtn.removeEventListener("click", onClose);
      cancelBtn.removeEventListener("click", onClose);
      window.removeEventListener("keydown", onWindowKey);
    };

    const onClose = () => removePopup();

    const onGenerate = async () => {
      const userPrompt = (promptArea.value || "").trim();
      if (!userPrompt) {
        // Gunakan toast dari Acode
        acode.toast("Please enter a description", 3000);
        return;
      }

      // Remove popup before processing (keamanan & UX)
      removePopup();

      try {
        await this.processCodeGeneration(userPrompt);
      } catch (err) {
        console.error("processCodeGeneration error:", err);
      }
    };

    const promptKeydown = (e) => {
      // Ctrl/Cmd + Enter => generate
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        generateBtn.click();
      }
    };

    const onWindowKey = (e) => {
      // Escape => close
      if (e.key === "Escape") {
        removePopup();
      }
    };

    // Wire listeners
    closeBtn.addEventListener("click", onClose);
    cancelBtn.addEventListener("click", onClose);
    generateBtn.addEventListener("click", onGenerate);
    promptArea.addEventListener("keydown", promptKeydown);
    window.addEventListener("keydown", onWindowKey);

    // Small debug log supaya gampang ngecek
    console.log("AI Generate popup opened in container:", container === document.body ? "body" : "#acode-ai-assistant");
  }

  async processCodeGeneration(userPrompt) {
    // Input validation
    if (!userPrompt || userPrompt.trim().length === 0) {
      acode.toast("Please provide a description for code generation", 3000);
      return;
    }

    if (userPrompt.length > 1000) {
      acode.toast("Description too long. Please keep it under 1000 characters", 3000);
      return;
    }

    const activeFile = acode.editorManager.activeFile;
    let fileContent = "";
    let fileExtension = "js"; // default extension

    if (activeFile) {
      fileContent = acode.editor.getValue();
      fileExtension = activeFile.name.split('.').pop() || "js";
    }

    // Show loading
    acode.loader.showTitleLoader();
    acode.toast("Generating code...", 3000);

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
        acode.toast('Primary AI service failed', 4000);
        // Fallback: try with basic model if advanced fails
        try {
          response = await this.sendAiQuery(aiPrompt);
        } catch (fallbackError) {
          acode.toast('Fallback AI service also failed', 4000);
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
      const cursor = acode.editor.getCursorPosition();
      acode.editor.session.insert(cursor, generatedCode + '\n');

      // Auto-save if file exists
      if (activeFile && activeFile.uri) {
        try {
          await activeFile.save();
          acode.toast("Code generated and saved successfully!", 3000);
        } catch (saveError) {
          acode.toast("Code generated! Please save manually.", 3000);
        }
      } else {
        acode.toast("Code generated successfully!", 3000);
      }

      // Ask if user wants to run the code
      setTimeout(async () => {
        const select = acode.require('select');
        const shouldRun = await select("Run the generated code?", ["Yes", "No", "Cancel"]);
        if (shouldRun === "Yes") {
          this.runCurrentFile(); // Removed await since we're not checking the result
        }
      }, 1000);

    } catch (error) {
      acode.toast(`Code generation failed: ${error.message}`, 4000);

      // Show fallback options
      setTimeout(async () => {
        const select = acode.require('select');
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
      acode.loader.removeTitleLoader();
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
    if (!this.$page || !this.$page.isVisible) {
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
    if (!this.$page || !this.$page.isVisible) {
      await this.run();
    }

    // Add the query to chat
    this.appendUserQuery(prompt);
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(prompt);
  }

  // Helper methods within the same function scope
  createSearchDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'ai-search-overlay';
    overlay.innerHTML = `
    <div class="ai-search-dialog">
      <div class="ai-search-header">
        <h3>🔍 Chat Search</h3>
        <button class="ai-search-close">×</button>
      </div>
      
      <div class="ai-search-body">
        <div class="ai-search-input-group">
          <input type="text" id="ai-search-input" placeholder="Enter search term..." autocomplete="off">
          <button id="ai-search-clear" title="Clear">✕</button>
        </div>
        
        <div class="ai-search-options">
          <div class="ai-search-scope">
            <label>Search in:</label>
            <select id="ai-search-scope">
              <option value="current">Current Chat</option>
              <option value="all">All Chat History</option>
              <option value="session">Specific Session</option>
            </select>
          </div>
          
          <div class="ai-search-filters">
            <label><input type="checkbox" id="ai-case-sensitive"> Case sensitive</label>
            <label><input type="checkbox" id="ai-whole-word"> Whole words only</label>
          </div>
        </div>
        
        <div id="ai-session-selector" class="ai-session-selector" style="display: none;">
          <label>Select session:</label>
          <select id="ai-session-list">
            <option value="">Select session...</option>
          </select>
        </div>
      </div>
      
      <div class="ai-search-footer">
        <button id="ai-search-cancel" class="ai-btn-secondary">Cancel</button>
        <button id="ai-search-submit" class="ai-btn-primary">🔍 Search</button>
      </div>
    </div>
  `;

    return overlay;
  }

  searchCurrentChat(options) {
    const results = [];
    const chatBox = this.$chatBox || document.querySelector('.chatBox');
    if (!chatBox) return results;

    const messages = chatBox.querySelectorAll('.message, .ai_message');
    const { searchTerm, caseSensitive, wholeWord } = options;

    messages.forEach((element, index) => {
      if (!element || !element.textContent) return;

      const text = element.textContent;
      const isMatch = this.testMatch(text, searchTerm, caseSensitive, wholeWord);

      if (isMatch) {
        const isUser = element.closest('.wrapper') !== null;
        results.push({
          element,
          text: text.trim(),
          isUser,
          source: 'current',
          index,
          preview: this.generatePreview(text, searchTerm, caseSensitive)
        });
      }
    });

    return results;
  }

  searchAllHistory(options) {
    const results = [];

    // Search current chat
    results.push(...this.searchCurrentChat(options));

    // Search stored histories
    if (this.messageHistories) {
      Object.entries(this.messageHistories).forEach(([sessionId, messages]) => {
        if (messages && Array.isArray(messages)) {
          const sessionResults = this.searchMessageArray(messages, options, sessionId);
          results.push(...sessionResults);
        }
      });
    }

    return results;
  }

  searchSpecificSession(options) {
    const { sessionId } = options;
    if (!sessionId || !this.messageHistories || !this.messageHistories[sessionId]) {
      return [];
    }

    return this.searchMessageArray(this.messageHistories[sessionId], options, sessionId);
  }

  searchMessageArray(messages, options, sessionId) {
    const results = [];
    const { searchTerm, caseSensitive, wholeWord } = options;

    messages.forEach((msg, index) => {
      if (!msg || !msg.content) return;

      const text = msg.content;
      const isMatch = this.testMatch(text, searchTerm, caseSensitive, wholeWord);

      if (isMatch) {
        results.push({
          text: text.trim(),
          isUser: msg.role === 'user',
          source: sessionId,
          index,
          timestamp: msg.timestamp,
          preview: this.generatePreview(text, searchTerm, caseSensitive)
        });
      }
    });

    return results;
  }

  testMatch(text, searchTerm, caseSensitive, wholeWord) {
    if (wholeWord) {
      const flags = caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(`\\b${this.escapeRegex(searchTerm)}\\b`, flags);
      return regex.test(text);
    } else {
      const searchText = caseSensitive ? text : text.toLowerCase();
      const pattern = caseSensitive ? searchTerm : searchTerm.toLowerCase();
      return searchText.includes(pattern);
    }
  }

  generatePreview(text, searchTerm, caseSensitive = false) {
    const maxLength = 150;
    const searchPattern = caseSensitive ? searchTerm : searchTerm.toLowerCase();
    const searchText = caseSensitive ? text : text.toLowerCase();

    const index = searchText.indexOf(searchPattern);
    if (index === -1) return text.substring(0, maxLength) + '...';

    const start = Math.max(0, index - 50);
    const end = Math.min(text.length, index + searchTerm.length + 50);

    let preview = text.substring(start, end);
    if (start > 0) preview = '...' + preview;
    if (end < text.length) preview = preview + '...';

    // Highlight the search term
    const regex = new RegExp(`(${this.escapeRegex(searchTerm)})`, caseSensitive ? 'g' : 'gi');
    preview = preview.replace(regex, '<mark>$1</mark>');

    return preview;
  }

  showSearchResults(results, searchTerm) {
    // Clear previous highlights
    this.clearSearchHighlights();

    const overlay = document.createElement('div');
    overlay.className = 'ai-search-results-overlay';
    overlay.innerHTML = `
    <div class="ai-search-results-dialog">
      <div class="ai-search-results-header">
        <h3>🎯 Search Results (${results.length})</h3>
        <div class="ai-search-results-actions">
          <button id="ai-highlight-all" class="ai-btn-small">✨ Highlight All</button>
          <button class="ai-search-close">×</button>
        </div>
      </div>
      
      <div class="ai-search-results-body">
        <div class="ai-search-results-list">
          ${results.map((result, index) => `
            <div class="ai-search-result-item" data-index="${index}">
              <div class="ai-search-result-header">
                <span class="ai-search-result-type">${result.isUser ? '👤 User' : '🤖 AI'}</span>
                <span class="ai-search-result-source">📍 ${result.source}</span>
                ${result.timestamp ? `<span class="ai-search-result-time">🕒 ${new Date(result.timestamp).toLocaleString()}</span>` : ''}
              </div>
              <div class="ai-search-result-preview">${result.preview}</div>
              <div class="ai-search-result-actions">
                <button class="ai-jump-btn" data-index="${index}">🎯 Jump to Message</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      
      <div class="ai-search-results-footer">
        <span class="ai-search-stats">Found ${results.length} results for "${searchTerm}"</span>
        <button id="ai-results-close" class="ai-btn-primary">Close</button>
      </div>
    </div>
  `;

    document.body.appendChild(overlay);

    // Event handlers
    overlay.querySelector('#ai-highlight-all').addEventListener('click', () => {
      this.highlightSearchResults(results);
      window.toast && window.toast(`✨ Highlighted ${results.length} results`, 2000);
    });

    overlay.querySelectorAll('.ai-jump-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.dataset.index);
        this.jumpToSearchResult(results[index]);
      });
    });

    overlay.querySelectorAll('.ai-search-result-item').forEach((item, index) => {
      item.addEventListener('click', () => {
        this.jumpToSearchResult(results[index]);
      });
    });

    const closeDialog = () => {
      document.body.removeChild(overlay);
    };

    overlay.querySelector('.ai-search-close').addEventListener('click', closeDialog);
    overlay.querySelector('#ai-results-close').addEventListener('click', closeDialog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeDialog();
    });

    window.toast && window.toast(`🎯 Found ${results.length} results for "${searchTerm}"`, 3000);
  }

  highlightSearchResults(results) {
    this.clearSearchHighlights();

    results.forEach(result => {
      if (result.element && result.source === 'current') {
        result.element.classList.add('ai-search-highlight');
        result.element.style.background = 'rgba(0, 212, 255, 0.15)';
        result.element.style.border = '2px solid var(--galaxy-star-blue)';
        result.element.style.boxShadow = '0 0 20px rgba(0, 212, 255, 0.3)';
      }
    });
  }

  jumpToSearchResult(result) {
    if (result.element && result.source === 'current') {
      // Highlight and scroll to result
      result.element.classList.add('ai-search-highlight-active');
      result.element.style.background = 'rgba(0, 212, 255, 0.25)';
      result.element.style.border = '2px solid var(--galaxy-star-purple)';
      result.element.style.boxShadow = '0 0 30px rgba(157, 78, 221, 0.5)';
      result.element.style.transform = 'scale(1.02)';

      result.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Remove active highlight after animation
      setTimeout(() => {
        result.element.classList.remove('ai-search-highlight-active');
        result.element.style.transform = '';
      }, 2000);
    } else {
      window.toast && window.toast(`📍 Result from ${result.source} session`, 2000);
    }
  }

  clearSearchHighlights() {
    const chatBox = this.$chatBox || document.querySelector('.chatBox');
    if (chatBox) {
      chatBox.querySelectorAll('.ai-search-highlight').forEach(el => {
        el.classList.remove('ai-search-highlight', 'ai-search-highlight-active');
        el.style.removeProperty('background');
        el.style.removeProperty('border');
        el.style.removeProperty('box-shadow');
        el.style.removeProperty('transform');
      });
    }
  }

  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    if (!this.$page || !this.$page.isVisible) {
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
      this.analyzeCurrentCode();
    } else {
      window.toast("Real-time Renz Ai disabled", 2000);
      this.showRealTimeStatus(false);
      this.clearSuggestions();
      this.clearErrorMarkers();
    }
  }

  showRealTimeStatus(enabled) {
    try {
      // Update UI to show real-time status
      let statusElement = null;
      try {
        statusElement = document.querySelector('.realtime-ai-status');
      } catch (error) {
        // Could not query status element
      }

      if (!statusElement) {
        statusElement = tag("div", { className: "realtime-ai-status" });
      }

      statusElement.textContent = enabled ? "😍AI Active" : "";
      statusElement.style.cssText = `
    position: fixed;
    top: 10px;
    right: 110px;
    background: ${enabled ? 'rgba(76, 175, 80, 0.7)' : 'rgba(0,0,0,0.3)'};
    color: white;
    padding: 3px 6px;
    border-radius: 10px;
    font-size: 10px;
    opacity: 0.7;
    z-index: 1000;
    transition: all 0.3s ease;
  `;

      try {
        if (enabled && statusElement && document.body && !document.body.contains(statusElement)) {
          document.body.appendChild(statusElement);
        } else if (!enabled && statusElement && document.body && document.body.contains(statusElement)) {
          document.body.removeChild(statusElement);
        }
      } catch (error) {
        // Could not modify status element in DOM
      }
    } catch (error) {
      // Silent fail for status display
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
    if (this.realTimeEnabled && editor && editor.session) {
      try {
        this.showContextualSuggestions();
      } catch (error) {
        // Silent fail for cursor change errors
      }
    }
  }

  async analyzeCurrentCode() {
    try {
      const activeFile = editorManager && editorManager.activeFile;
      if (!activeFile || !editor || !editor.session) return;

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
        try {
          this.addImportToFile(imp);
          if (notification && document.body && document.body.contains(notification)) {
            document.body.removeChild(notification);
          }
        } catch (error) {
          window.toast('Error adding import', 3000);
        }
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
      try {
        if (notification && document.body && document.body.contains(notification)) {
          document.body.removeChild(notification);
        }
      } catch (error) {
        // Could not remove notification from DOM
      }
    };

    notification.append(title, importList, closeBtn);
    try {
      if (document.body) {
        document.body.appendChild(notification);
      }
    } catch (error) {
      // Could not add notification to DOM
    }

    // Auto remove after 10 seconds
    setTimeout(() => {
      try {
        if (notification && document.body && document.body.contains(notification)) {
          document.body.removeChild(notification);
        }
      } catch (error) {
        // Could not remove notification from DOM
      }
    }, 10000);
  }

  addImportToFile(importStatement) {
    try {
      if (!editor) {
        window.toast('Editor not available', 3000);
        return;
      }

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
      if (editor.session && typeof editor.session.insert === 'function') {
        editor.session.insert({ row: insertLine, column: 0 }, importStatement + '\n');
        window.toast(`Added import: ${importStatement}`, 2000);
      } else {
        window.toast('Could not insert import', 3000);
      }
    } catch (error) {
      window.toast('Error adding import: ' + (error.message || 'Unknown error'), 3000);
    }
  }

  showContextualSuggestions() {
    try {
      if (!editor || !editor.getCursorPosition || !editor.renderer) {
        return;
      }

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
            this.applySuggestions(suggestion);
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
    } catch (error) {
      window.toast('Error showing contextual suggestions', 3000);
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
    if (this.errorMarkers) {
      this.errorMarkers.forEach(marker => {
        editor.session.removeMarker(marker);
      });
      this.errorMarkers = [];
    }
    if (editor && editor.session) {
      editor.session.clearAnnotations();
    }
  }

  createSuggestionWidget() {
    if (this.suggestionWidget) {
      this.suggestionWidget.remove();
    }

    this.suggestionWidget = tag("div", {
      className: "ai-suggestion-widget"
    });

    try {
      if (document.body) {
        document.body.appendChild(this.suggestionWidget);
      }
    } catch (error) {
      // Could not add suggestion widget to DOM
    }
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
          this.applySuggestions(suggestion);
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

  applySuggestions(suggestion) {
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
      window.toast(`Error applying completion: ${error.message}`, 3000);
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
      window.toast(`Error applying quick fix: ${error.message}`, 3000);
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
          const secretFs = fs(secretKeyPath);
          if (secretFs && await secretFs.exists()) {
            await secretFs.delete();
          }
        }
      } catch (error) {
        // Could not remove secret key file
      }

      // Remove real-time context file
      try {
        const contextPath = window.DATA_STORAGE + "realtime-context.json";
        const contextFs = fs(contextPath);
        if (contextFs && await contextFs.exists()) {
          await contextFs.delete();
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
    }
  );
  acode.setPluginUnmount(plugin.id, () => {
    acodePlugin.destroy();
  });
}
