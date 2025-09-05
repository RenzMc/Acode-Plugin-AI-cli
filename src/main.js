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
  this.realTimeDelay = 2000; // 1 detik delay
  this.lastAnalyzedContent = "";
  this.currentSuggestions = [];
  this.suggestionWidget = null;
  this.errorMarkers = [];
  this.realTimeAnalysisCache = new Map();
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
      description: "AI Assistant",
      exec: this.run.bind(this),
    });

    selectionMenu.add(async () => {
      let opt = await select("AI Actions", [
        "Explain Code", 
        "Rewrite", 
        "Generate Code",
        "Optimize Function",
        "Add Comments",
        "Generate Docs",
        "Edit with AI"
      ]);
      
      if (opt) {
        const selectedText = editor.getSelectedText();
        if (selectedText) {
          await this.handleSelectionAction(opt, selectedText);
        } else {
          window.toast("Please select some code first", 3000);
        }
      }
    }, "âœ¨", 'all');

    $page.id = "acode-ai-assistant";
    $page.settitle("AI Assistant");
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
    const contextPrompt = `Current file: ${activeFile.name}\n\nContent:\n\`\`\`\n${content}\n\`\`\`\n\nHow can I help you with this code?`;
    
    if (!this.$page.isVisible) {
      await this.run();
    }
    
    this.$chatTextarea.value = contextPrompt;
    this.$chatTextarea.focus();
  } else {
    window.toast("No active file to insert context", 3000);
  }
};

    // Add provider dropdown to toolbar
    const providerDropdown = this.createProviderDropdown();
    
    this.$page.header.append(providerDropdown, newChatBtn, insertContextBtn, historyBtn, menuBtn);

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
      <li action="create-file-ai">Create File with AI</li>
      <li action="organize-project">Organize Project</li>
      <li action="bulk-operations">Bulk Operations</li>
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
    this.messageHistories = {};
    this.messageSessionConfig = {
      configurable: {
        sessionId: uuidv4(),
      },
    };
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
          window.toast("Configuration saved ðŸŽ‰", 3000);
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
          window.toast("Configuration saved ðŸŽ‰", 3000);
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
      console.error("Error in run method:", e);
      window.toast("Error initializing AI Assistant: " + e.message, 5000);
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
    utility function for removing special characters and
    white spaces from file names
    */
    // Remove special characters and symbols
    const sanitizedFileName = fileName.replace(/[^\w\s.-]/gi, "");
    // Trim leading and trailing spaces
    const trimmedFileName = sanitizedFileName.trim();
    // Replace spaces with underscores
    const finalFileName = trimmedFileName.replace(/\s+/g, "_");
    return finalFileName;
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
      .filter((pair) => pair !== null);

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
      console.error(err.message);
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
      this.appendUserQuery(chatText.value);
      this.scrollToBottom();
      this.appendGptResponse("");
      this.loader();
      this.getCliResponse(chatText.value);
      chatText.value = "";
    }
  }

  async appendUserQuery(message) {
    /*
    add user query to ui
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
        className: "message",
        textContent: message,
      });
      chat.append(...[profileImg, msg]);
      userChatBox.append(chat);
      this.$chatBox.appendChild(userChatBox);
    } catch (err) {
      window.alert(err);
    }
  }

  async appendGptResponse(message) {
  try {
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
    
    // Render markdown with proper handling
    if (this.$mdIt && typeof this.$mdIt.render === 'function') {
      msg.innerHTML = this.$mdIt.render(message);
      
      // Add event listeners to copy buttons
      setTimeout(() => {
        const copyBtns = msg.querySelectorAll(".copy-button");
        if (copyBtns && copyBtns.length > 0) {
          for (const copyBtn of copyBtns) {
            copyBtn.addEventListener("click", function () {
              copy(this.dataset.str);
              window.toast("Copied to clipboard", 3000);
            });
          }
        }
      }, 100);
    } else {
      // Fallback if markdown-it isn't ready
      msg.textContent = message;
      console.warn("Markdown renderer not available, falling back to plain text");
    }

    chat.append(...[profileImg, msg]);
    gptChatBox.append(chat);
    this.$chatBox.appendChild(gptChatBox);
  } catch (err) {
    console.error("Error in appendGptResponse:", err);
    window.toast("Error displaying AI response", 3000);
  }
}

  async stopGenerating() {
    // Currently this doesn't works and I have no idea about , If you can , feel free to open pr
    // it doesn't work 
    this.abortController.abort();
    this.$stopGenerationBtn.classList.add("hide");
    this.$sendBtn.classList.remove("hide");
  }

  async getCliResponse(question) {
  try {
    // Make sure we have response boxes
    const responseBoxes = Array.from(document.querySelectorAll(".ai_message"));
    if (responseBoxes.length === 0) {
      console.error("No response box found");
      // Create a response box if none exists
      this.appendGptResponse("");
      // Try again with the newly created box
      setTimeout(() => this.getCliResponse(question), 100);
      return;
    }

    const targetElem = responseBoxes[responseBoxes.length - 1];
    if (!targetElem) {
      console.error("Target element not found");
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

            // Add event listeners to copy buttons
            setTimeout(() => {
              const copyBtns = targetElem.querySelectorAll(".copy-button");
              if (copyBtns && copyBtns.length > 0) {
                for (const copyBtn of copyBtns) {
                  copyBtn.addEventListener("click", function () {
                    copy(this.dataset.str);
                    window.toast("Copied to clipboard", 3000);
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

    const prompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        `You are Renz AI CLI assistant for the open source plugin Renz Ai Cli for Acode code editor(open source vscode like code editor for Android). You help users with code editing, file operations, and AI-powered development tasks. You can read files, edit files, delete files, show diffs, search and replace across project files, and perform various coding tasks. Always be helpful and provide clear, actionable responses. When asked to create files or edit code, provide complete, functional implementations.`,
      ],
      ["placeholder", "{chat_history}"],
      ["human", "{input}"],
    ]);

    const parser = new StringOutputParser();
    const chain = prompt.pipe(this.modelInstance).pipe(parser);

    const withMessageHistory = new RunnableWithMessageHistory({
      runnable: chain,
      getMessageHistory: async (sessionId) => {
        if (this.messageHistories[sessionId] === undefined) {
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

    for await (const chunk of stream) {
      result += chunk;
      targetElem.textContent += chunk;
      this.scrollToBottom();
    }

    // Cache the response
    this.setCachedResponse(question, result);

    // Render markdown if available
    if (this.$mdIt && typeof this.$mdIt.render === 'function') {
      try {
        const renderedHtml = this.$mdIt.render(result);
        targetElem.innerHTML = renderedHtml;

        // Add event listeners to copy buttons
        setTimeout(() => {
          const copyBtns = targetElem.querySelectorAll(".copy-button");
          if (copyBtns && copyBtns.length > 0) {
            for (const copyBtn of copyBtns) {
              copyBtn.addEventListener("click", function () {
                const codeText = this.dataset.str;
                copy(codeText);
                window.toast("Copied to clipboard", 3000);

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
        console.error("Error rendering markdown:", renderError);
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
    console.error("Error in getCliResponse:", error);

    const responseBoxes = Array.from(document.querySelectorAll(".ai_message"));
    clearInterval(this.$loadInterval);

    if (responseBoxes.length > 0) {
      const targetElem = responseBoxes[responseBoxes.length - 1];
      if (targetElem) {
        targetElem.innerHTML = "";
        const $errorBox = tag("div", { className: "error-box" });

        if (error.response) {
          $errorBox.innerText = `Status code: ${error.response.status}\n${JSON.stringify(error.response.data)}`;
        } else {
          $errorBox.innerText = `${error.message}`;
        }
        targetElem.appendChild($errorBox);
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
    // made change in last element
    if (loadingDots.length != 0) {
      this.$loadInterval = setInterval(() => {
        loadingDots[loadingDots.length - 1].innerText += "â€¢";
        if (loadingDots[loadingDots.length - 1].innerText == "â€¢â€¢â€¢â€¢â€¢â€¢") {
          loadingDots[loadingDots.length - 1].innerText = "â€¢";
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
      const loadingToast = window.toast("Generating file based on your description...", 0);
      
      const aiPrompt = `Based on this description: "${description}"
      
      Create:
      1. Appropriate filename with extension (use descriptive names)
      2. Complete file content based on the description
      
      The file should be fully functional and ready to use.
      
      Respond in JSON format:
      {
        "filename": "suggested_name.ext",
        "content": "file content here",
        "explanation": "brief explanation of the file"
      }`;
      
      const response = await this.getAiResponse(aiPrompt);
      
      // Hide loading indicator
      if (loadingToast && typeof loadingToast.hide === 'function') {
        loadingToast.hide();
      }
      
      try {
        // Extract JSON from response if it's embedded in markdown
        let jsonStr = response;
        const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch && jsonMatch[1]) {
          jsonStr = jsonMatch[1];
        }
        
        // Parse the JSON response
        const suggestion = JSON.parse(jsonStr);
        
        // Show confirmation dialog with the suggestion
        const confirmCreate = await multiPrompt("Create File", [
          {
            id: "filename",
            placeholder: "Filename",
            value: suggestion.filename,
            type: "text",
            required: true
          },
          {
            id: "content", 
            placeholder: "Content",
            value: suggestion.content,
            type: "textarea"
          }
        ]);
        
        if (confirmCreate) {
          const fullPath = basePath ? `${basePath}/${confirmCreate.filename}` : confirmCreate.filename;
          
          // Create the file
          await fs(fullPath).writeFile(confirmCreate.content);
          window.toast(`File created: ${confirmCreate.filename}`, 3000);
          
          // Close the AI assistant page if it's open
          if (this.$page && this.$page.isVisible) {
            this.$page.hide();
          }
          
          // Open the created file in the editor
          const openedFile = await editorManager.openFile(fullPath);
          if (!openedFile) {
            // Fallback if direct opening fails
            editorManager.addNewFile(confirmCreate.filename, {
              text: confirmCreate.content
            });
          }
        }
      } catch (parseError) {
        console.error("Error parsing AI response:", parseError);
        
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
      console.error("Error in createFileWithAI:", error);
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
      
      const response = await this.getAiResponse(aiPrompt);
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
      const projectFiles = await this.scanProjectStructure();
      
      const aiPrompt = `Analyze this project structure and suggest improvements:
      
      Current structure:
      ${JSON.stringify(projectFiles, null, 2)}
      
      Suggest:
      1. Better folder organization
      2. Files that should be moved
      3. New folders to create
      4. Files that might be redundant
      
      Provide actionable reorganization steps.`;
      
      const response = await this.getAiResponse(aiPrompt);
      
      // Show suggestions in chat
      if (!this.$page.isVisible) {
        await this.run();
      }
      
      this.appendUserQuery("Analyze and suggest project structure improvements");
      this.appendGptResponse(response);
      
    } catch (error) {
      window.toast(`Error analyzing project: ${error.message}`, 3000);
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
        
        if (await fs(dirPath).exists()) {
          const items = await fs(dirPath).lsDir();
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
                size: item.length,
                extension: item.name.split('.').pop()
              });
            }
          }
        }
      };
      
      await scanDir(window.PLUGIN_DIR || '/sdcard');
      
      this.projectStructure = structure;
      this.lastStructureScan = Date.now();
      
      return structure;
    } catch (error) {
      console.error('Error scanning project structure:', error);
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
      const pattern = await prompt("Enter naming pattern (use {index} for numbers):", "file_{index}.js", "text");
      if (!pattern) return;
      
      const files = await this.selectMultipleFiles();
      if (!files.length) return;
      
      const confirmRename = await select("Confirm bulk rename?", ["Yes", "No"]);
      if (confirmRename === "Yes") {
        for (let i = 0; i < files.length; i++) {
          const newName = pattern.replace('{index}', i + 1);
          const newPath = files[i].replace(files[i].split('/').pop(), newName);
          await fs(files[i]).moveTo(newPath);
        }
        window.toast(`Renamed ${files.length} files`, 3000);
      }
    } catch (error) {
      window.toast(`Bulk rename error: ${error.message}`, 3000);
    }
  }

  async selectMultipleFiles() {
    // Implementation for selecting multiple files
    // This would need a custom multi-select dialog
    const projectFiles = await this.getAllProjectFiles(['.js', '.json', '.html', '.css', '.md']);
    return projectFiles.slice(0, 5); // Placeholder - return first 5 files
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
    Edit file content in project with backup
    */
    try {
      // Create backup before editing
      if (await fs(filePath).exists()) {
        const originalContent = await fs(filePath).readFile('utf8');
        const backupPath = filePath + '.backup.' + Date.now();
        await fs(backupPath).writeFile(originalContent);
        
        // Store backup info for undo
        this.storeUndoInfo(filePath, originalContent);
      }
      
      await fs(filePath).writeFile(newContent);
      return { success: true, message: `File edited successfully: ${filePath}` };
    } catch (error) {
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
        
        // Escape HTML to prevent rendering issues
        const escapeHtml = (text) => {
          return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
        };
        
        const escapedOrigLine = escapeHtml(origLine);
        const escapedNewLine = escapeHtml(newLine);
        
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
      console.error("Error generating diff:", error);
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
      
      await scanDirectory(window.PLUGIN_DIR || '/sdcard');
      return files;
    } catch (error) {
      console.error('Error scanning project files:', error);
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
      await fs(lastOp.filePath).writeFile(lastOp.content);
      
      return { success: true, message: `Undone changes to ${lastOp.filePath}` };
    } catch (error) {
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
        console.warn(`Could not resolve import: ${importPath}`);
      }
    }
    
    return { success: true, files: relatedFiles, imports };
  } catch (error) {
    console.error('Error reading related files:', error);
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
    console.error('Error switching provider:', error);
    window.toast(`Error switching provider: ${error.message}`, 3000);
  }
}

  showAiEditPopup(initialText = "") {
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
    
    // Event listeners
    closeBtn.onclick = cancelBtn.onclick = () => {
      document.body.removeChild(popup);
    };
    
    editBtn.onclick = async () => {
      const prompt = promptArea.value.trim();
      if (prompt) {
        document.body.removeChild(popup);
        await this.processAiEdit(prompt);
      }
    };
    
    // Handle Enter key
    promptArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        editBtn.click();
      }
    });
    
    document.body.appendChild(popup);
    promptArea.focus();
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
    
    let aiPrompt;
    if (selection) {
      aiPrompt = `Here's the selected code to edit:\n\`\`\`${fileExtension}\n${selection}\n\`\`\`\n\nUser request: "${userPrompt}"\n\nPlease provide the improved/edited version of just the selected code. Make sure your changes are complete and functional. Return ONLY the edited code without any explanations or markdown formatting.`;
    } else {
      aiPrompt = `Here's the full file content to edit:\n\`\`\`${fileExtension}\n${currentContent}\n\`\`\`\n\nUser request: "${userPrompt}"\n\nPlease provide the complete improved file. Make sure your changes are complete and functional. Return ONLY the edited code without any explanations or markdown formatting.`;
    }
    
    const response = await this.getAiResponse(aiPrompt);
    
    if (response) {
      // Extract code from response, handling various formats
      let newCode = response;
      
      // Try to extract code from markdown code blocks
      const codeMatch = response.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
      if (codeMatch && codeMatch[1]) {
        newCode = codeMatch[1];
      } else {
        // If no code block found, try to remove any explanations or markdown
        const lines = response.split('\n');
        const codeLines = lines.filter(line => 
          !line.startsWith('#') && 
          !line.startsWith('>') && 
          !line.match(/^[0-9]+\.\s/) &&
          !line.match(/^\*\s/)
        );
        newCode = codeLines.join('\n');
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
        
        // Save the file if it exists on disk
        if (activeFile.uri) {
          try {
            await fs(activeFile.uri).writeFile(editor.getValue());
            window.toast("File updated and saved successfully!", 3000);
          } catch (saveError) {
            console.error("Error saving file:", saveError);
            window.toast("Code updated but couldn't save file", 3000);
          }
        } else {
          window.toast("Code updated successfully!", 3000);
        }
      }
    } else {
      throw new Error("No response from AI");
    }
  } catch (error) {
    console.error('Error in processAiEdit:', error);
    window.toast(`Error: ${error.message}`, 3000);
  } finally {
    if (loadingToast && typeof loadingToast.hide === 'function') {
      loadingToast.hide();
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
      innerHTML: "Ã—",
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
    // Buka chat dan kirim prompt
    if (!this.$page.isVisible) {
      await this.run();
    }
    
    let fileContent = "";
    if (activeFile) {
      fileContent = editor.getValue();
    }
    
    const systemPrompt = `You are a professional code explainer. Analyze the provided code and explain it in detail, professionally, and comprehensively.`;
    const userPrompt = `Please explain this code in detail:\n\n**File: ${activeFile ? activeFile.name : 'Unknown'}**\n\n**Selected Code:**\n\`\`\`\n${selectedText}\n\`\`\`\n\n**Full File Content:**\n\`\`\`\n${fileContent}\n\`\`\`\n\nPlease provide a detailed and professional explanation of what this code does, how it works, its dependencies, and any potential improvements.`;

    this.appendUserQuery(userPrompt);
    this.scrollToBottom();
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
  } catch (error) {
    console.error("Error in explainCodeWithChat:", error);
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
    innerHTML: "Ã—"
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
  let fileExtension = "";
  
  if (activeFile) {
    fileContent = editor.getValue();
    fileExtension = activeFile.name.split('.').pop();
  }
  
  const systemPrompt = `You are a professional code generator. Generate clean, efficient, and well-documented code based on user requirements. Consider the current file context and dependencies.`;
  
  const enhancedPrompt = `${systemPrompt}\n\n**Current File: ${activeFile ? activeFile.name : 'New File'}**\n**File Type: ${fileExtension}**\n\n**Current File Content:**\n\`\`\`\n${fileContent}\n\`\`\`\n\n**User Request:** ${userPrompt}\n\nPlease generate the requested code. Consider:\n1. Current file dependencies and imports\n2. Existing code structure and patterns\n3. Best practices for ${fileExtension} files\n4. Proper error handling and optimization\n\nGenerate the code and insert it at the current cursor position.`;

  // Show loading
  const loadingToast = window.toast("Generating code...", 0);
  
  try {
    const response = await this.getAiResponse(enhancedPrompt);
    if (response) {
      const codeMatch = response.match(/```[\w]*\n([\s\S]*?)\n```/);
      const generatedCode = codeMatch ? codeMatch[1] : response;
      
      // Insert at cursor position
      const cursor = editor.getCursorPosition();
      editor.session.insert(cursor, generatedCode);
      
      window.toast("Code generated successfully!", 3000);
    } else {
      throw new Error("No response from AI");
    }
  } catch (error) {
    console.error('Error generating code:', error);
    window.toast(`Error generating code: ${error.message}`, 3000);
  } finally {
    // Hide loading toast
    if (loadingToast && typeof loadingToast.hide === 'function') {
      loadingToast.hide();
    }
  }
}


  async generateCode(description) {
    const prompt = `Generate code based on this description: ${description}`;
    await this.sendAiQuery(prompt);
  }

  async optimizeFunctionWithChat(selectedText) {
  if (!this.$page.isVisible) {
    await this.run();
  }
  
  const systemPrompt = `You are a code optimization expert. Analyze the provided function and suggest optimizations for better performance, readability, and maintainability.`;
  
  const userPrompt = `Please optimize this function:\n\n\`\`\`\n${selectedText}\n\`\`\`\n\nProvide optimized version with explanations of improvements made.`;

  this.appendUserQuery(userPrompt);
  this.appendGptResponse("");
  this.loader();
  await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
}

  async addCommentsWithChat(selectedText) {
  if (!this.$page.isVisible) {
    await this.run();
  }
  
  const systemPrompt = `You are a documentation expert. Add comprehensive, professional comments to the provided code.`;
  
  const userPrompt = `Please add detailed comments to this code:\n\n\`\`\`\n${selectedText}\n\`\`\`\n\nAdd comments explaining:\n1. What each section does\n2. Parameter descriptions\n3. Return value explanations\n4. Any complex logic`;

  this.appendUserQuery(userPrompt);
  this.appendGptResponse("");
  this.loader();
  await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
}

  async generateDocsWithChat(selectedText) {
  if (!this.$page.isVisible) {
    await this.run();
  }
  
  const activeFile = editorManager.activeFile;
  let fullContent = "";
  
  if (selectedText) {
    // Generate docs for selection
    const systemPrompt = `You are a technical documentation expert. Generate comprehensive documentation for the provided code.`;
    
    const userPrompt = `Generate professional documentation for this code:\n\n\`\`\`\n${selectedText}\n\`\`\`\n\nInclude JSDoc comments, usage examples, and API documentation.`;

    this.appendUserQuery(userPrompt);
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
  } else if (activeFile) {
    // Generate docs for entire file
    fullContent = editor.getValue();
    
    const systemPrompt = `You are a technical documentation expert. Generate comprehensive documentation for the entire file.`;
    
    const userPrompt = `Generate complete documentation for this file:\n\n**File: ${activeFile.name}**\n\n\`\`\`\n${fullContent}\n\`\`\`\n\nGenerate:\n1. File overview and purpose\n2. Function/class documentation\n3. Usage examples\n4. API reference\n5. Dependencies and requirements`;

    this.appendUserQuery(userPrompt);
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
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

  async getAiResponse(prompt) {
    try {
      if (!this.modelInstance) {
        throw new Error("AI model not initialized");
      }
      
      const response = await this.modelInstance.invoke(prompt);
      return response.content || response;
    } catch (error) {
      console.error("Error getting AI response:", error);
      return null;
    }
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
  
  const systemPrompt = `You are a code refactoring expert. Rewrite the provided code to be cleaner, more efficient, and follow best practices while maintaining the same functionality.`;
  
  const userPrompt = `Please rewrite this code to be cleaner and more efficient:\n\n\`\`\`\n${selectedText}\n\`\`\`\n\nProvide the rewritten version with explanations of improvements made.`;

  this.appendUserQuery(userPrompt);
  this.appendGptResponse("");
  this.loader();
  await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
}

  // Cache Management
  getCacheKey(prompt, provider, model) {
    return `${provider}_${model}_${btoa(prompt).substring(0, 50)}`;
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
  
  setupRealTimeAI() {
  // Toggle real-time AI command
  editor.commands.addCommand({
    name: "toggle_realtime_ai",
    description: "Toggle Real-time AI Assistant",
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
    window.toast("Real-time AI Assistant enabled âœ¨", 3000);
    this.showRealTimeStatus(true);
    this.analyzeCurrentFile();
  } else {
    window.toast("Real-time AI Assistant disabled", 2000);
    this.showRealTimeStatus(false);
    this.clearSuggestions();
    this.clearErrorMarkers();
  }
}

showRealTimeStatus(enabled) {
  // Update UI to show real-time status
  const statusElement = document.querySelector('.realtime-ai-status') || 
    tag("div", { className: "realtime-ai-status" });
  
  statusElement.textContent = enabled ? "ðŸ¤– AI Active" : "";
  statusElement.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: ${enabled ? '#4CAF50' : 'transparent'};
    color: white;
    padding: 5px 10px;
    border-radius: 15px;
    font-size: 12px;
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
    
    // Skip jika konten sama dengan analisis terakhir
    if (content === this.lastAnalyzedContent) return;
    this.lastAnalyzedContent = content;
    
    // Check cache first
    const cacheKey = this.getRealTimeCacheKey(content, cursorPos);
    const cached = this.realTimeAnalysisCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < 30000) { // 30 detik cache
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
    console.error('Real-time analysis error:', error);
  }
}

async performRealTimeAnalysis(content, currentLine, cursorPos, activeFile) {
  const fileExtension = activeFile.name.split('.').pop();
  
  const prompt = `Analyze this ${fileExtension} code in real-time and provide suggestions:\n\n**Current Line ${cursorPos.row + 1}:** ${currentLine}\n\n**Full Code:**\n\`\`\`${fileExtension}\n${content}\n\`\`\`\n\n**Cursor Position:** Line ${cursorPos.row + 1}, Column ${cursorPos.column + 1}\n\nProvide JSON response with:\n{\n  "syntax_errors": [{"line": number, "message": "error description", "severity": "error|warning"}],\n  "missing_imports": ["import suggestions"],\n  "code_suggestions": [{"line": number, "suggestion": "improvement suggestion", "type": "optimization|style|bug"}],\n  "auto_complete": ["completion1", "completion2"],\n  "quick_fixes": [{"line": number, "issue": "problem", "fix": "solution"}]\n}\n\nFocus on:\n1. Syntax errors and missing imports\n2. Code improvements at cursor position\n3. Auto-completion suggestions\n4. Quick fixes for common issues`;

  try {
    const response = await this.getAiResponse(prompt);
    return JSON.parse(response);
  } catch (error) {
    console.error('AI analysis error:', error);
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
    textContent: "Ã—",
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

getRealTimeCacheKey(content, cursorPos) {
  const contentHash = btoa(content.substring(0, 200)).substring(0, 20);
  return `realtime_${contentHash}_${cursorPos.row}_${cursorPos.column}`;
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
    console.error('Error showing code suggestions:', error);
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
    console.error('Error showing auto complete:', error);
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
    console.error('Error showing quick fixes:', error);
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
    console.error('Error positioning suggestion widget:', error);
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
    console.error('Error applying suggestion:', error);
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
    console.error('Error applying completion:', error);
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
    console.error('Error applying quick fix:', error);
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
    console.error('File analysis error:', error);
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
    
    // Abort ongoing requests
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
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
        console.warn("Error closing WebSocket:", error);
      }
    }
    
    // Clear EventSource connections
    if (this.eventSource) {
      try {
        this.eventSource.close();
        this.eventSource = null;
      } catch (error) {
        console.warn("Error closing EventSource:", error);
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
    
    // Remove event listeners
    if (this.editorChangeListener) {
      try {
        editor.off('change', this.editorChangeListener);
        this.editorChangeListener = null;
      } catch (error) {
        console.warn("Could not remove editor change listener:", error);
      }
    }
    
    if (this.cursorChangeListener) {
      try {
        editor.off('changeSelection', this.cursorChangeListener);
        this.cursorChangeListener = null;
      } catch (error) {
        console.warn("Could not remove cursor change listener:", error);
      }
    }
    
    // Remove all commands including real-time commands
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
        console.warn(`Could not remove command: ${cmd}`);
      }
    });
    
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
    
    // Remove secret key file
    try {
      const secretKeyPath = window.DATA_STORAGE + "secret.key";
      if (await fs(secretKeyPath).exists()) {
        await fs(secretKeyPath).delete();
      }
    } catch (error) {
      console.warn("Could not remove secret key file:", error);
    }
    
    // Remove real-time context file
    try {
      const contextPath = window.DATA_STORAGE + "realtime-context.json";
      if (await fs(contextPath).exists()) {
        await fs(contextPath).delete();
      }
    } catch (error) {
      console.warn("Could not remove real-time context file:", error);
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
        console.warn("Could not remove DOM element:", error);
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
    
    console.log("AI Assistant plugin with real-time features destroyed successfully");
  } catch (error) {
    console.error("Error during plugin destruction:", error);
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
