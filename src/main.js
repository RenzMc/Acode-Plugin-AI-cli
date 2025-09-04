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
    }, "✨", 'all');

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
    
    this.setupRealTimeAI();
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
    this.$inputBox.append(this.$chatTextarea, this.$sendBtn, this.$stopGenerationBtn);
    mainApp.append(this.$inputBox, this.$chatBox);
    this.$page.append(mainApp);
    this.messageHistories = {};
    this.messageSessionConfig = {
      configurable: {
        sessionId: uuidv4(),
      },
    };
  }

  async run() {
    try {
      let passPhrase;
      if (await fs(window.DATA_STORAGE + "secret.key").exists()) {
        passPhrase = await fs(window.DATA_STORAGE + "secret.key").readFile(
          "utf-8",
        );
      } else {
        let secretPassphrase = await prompt(
          "Enter a secret pass pharse to save the api key",
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

          token = apiKey;
          providerNme = OPENAI_LIKE;
          await fs(window.DATA_STORAGE).createFile("secret.key", passPhrase);
          await this.apiKeyManager.saveAPIKey(OPENAI_LIKE, token);
          window.toast("Configuration saved 🎉", 3000);
        } 
        // Handle other providers
        else {
          // no prompt for api key in case of ollama
          let apiKey =
            modelProvider == AI_PROVIDERS[2]
              ? "No Need Of API Key"
              : await prompt("API key of selected provider", "", "text", {
                required: true,
              });
          if (!apiKey) return;
          loader.showTitleLoader();
          window.toast("Fetching available models from your account", 2000);
          let modelList = await getModelsFromProvider(modelProvider, apiKey);
          loader.removeTitleLoader();
          const modelNme = await select("Select AI Model", modelList);

          window.localStorage.setItem("ai-assistant-provider", modelProvider);
          window.localStorage.setItem("ai-assistant-model-name", modelNme);
          providerNme = modelProvider;
          token = apiKey;
          await fs(window.DATA_STORAGE).createFile("secret.key", passPhrase);
          await this.apiKeyManager.saveAPIKey(providerNme, token);
          window.toast("Configuration saved 🎉", 3000);
        }
      }

      let model = window.localStorage.getItem("ai-assistant-model-name");

      this.initiateModel(providerNme, token, model)
      this.$mdIt = window.markdownit({
        html: false,
        xhtmlOut: false,
        breaks: false,
        linkify: false,
        typographer: false,
        quotes: "“”‘’",
        highlight: function (str, lang) {
          const copyBtn = document.createElement("button");
          copyBtn.classList.add("copy-button");
          copyBtn.innerHTML = copyIconSvg;
          copyBtn.setAttribute("data-str", str);
          const codesArea = `<pre class="hljs codesArea"><code>${hljs.highlightAuto(str).value
            }</code></pre>`;
          const codeBlock = `<div class="codeBlock">${copyBtn.outerHTML}${codesArea}</div>`;
          return codeBlock;
        },
      });

      this.$sendBtn.addEventListener("click", this.sendQuery.bind(this));

      this.$page.show();
    } catch (e) {
      console.log(e);
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
            )}...</p><div><button class="delete-history-btn" style="height:25px;width:25px;border:none;padding:5px;outline:none;border-radius:50%;background:var(--error-text-color);text-align:center;">✗</button></div>
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
    /*
    add ai response to ui
    */
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
    msg.innerHTML = this.$mdIt.render(message);
    const copyBtns = msg.querySelectorAll(".copy-button");
    if (copyBtns) {
      for (const copyBtn of copyBtns) {
        copyBtn.addEventListener("click", function () {
          copy(this.dataset.str);
          window.toast("Copied to clipboard", 3000);
        });
      }
    }

    chat.append(...[profileImg, msg]);
    gptChatBox.append(chat);
    this.$chatBox.appendChild(gptChatBox);
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
      // Check cache first
      const cachedResponse = this.getCachedResponse(question);
      if (cachedResponse) {
        const responseBox = Array.from(document.querySelectorAll(".ai_message"));
        const targetElem = responseBox[responseBox.length - 1];
        
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
            const renderedHtml = this.$mdIt.render(cachedResponse);
            targetElem.innerHTML = renderedHtml;
            
            const copyBtns = targetElem.querySelectorAll(".copy-button");
            if (copyBtns) {
              for (const copyBtn of copyBtns) {
                copyBtn.addEventListener("click", function () {
                  copy(this.dataset.str);
                  window.toast("Copied to clipboard", 3000);
                });
              }
            }
            
            this.$stopGenerationBtn.classList.add("hide");
            this.$sendBtn.classList.remove("hide");
            window.toast("Response from cache", 1500);
          }
        };
        streamCache();
        return;
      }

      // Original AI request code...
      const responseBox = Array.from(document.querySelectorAll(".ai_message"));
      
      this.abortController = new AbortController();
      const { signal } = this.abortController;

      const prompt = ChatPromptTemplate.fromMessages([
        [
          "system",
          `You are Renz AI CLI assistant for the open source plugin Renz Ai Cli for Acode code editor(open source vscode like code editor for Android). You help users with code editing, file operations, and AI-powered development tasks. You can read files, edit files, delete files, show diffs, search and replace across project files, and perform various coding tasks. Always be helpful and provide clear, actionable responses.`,
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
            this.messageHistories[sessionId].addMessages(history.slice(-6))
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
      this.$stopGenerationBtn.classList.remove('hide');
      const targetElem = responseBox[responseBox.length - 1];
      targetElem.innerHTML = "";
      let result = "";
      
      for await (const chunk of stream) {
        result += chunk;
        targetElem.textContent += chunk;
        this.scrollToBottom();
      }
      
      // Cache the response
      this.setCachedResponse(question, result);
      
      const renderedHtml = this.$mdIt.render(result);
      targetElem.innerHTML = renderedHtml;
      
      const copyBtns = targetElem.querySelectorAll(".copy-button");
      if (copyBtns) {
        for (const copyBtn of copyBtns) {
          copyBtn.addEventListener("click", function () {
            copy(this.dataset.str);
            window.toast("Copied to clipboard", 3000);
          });
        }
      }
      this.$stopGenerationBtn.classList.add("hide");
      this.$sendBtn.classList.remove("hide");

      await this.saveHistory();
    } catch (error) {
      const responseBox = Array.from(document.querySelectorAll(".ai_message"));
      clearInterval(this.$loadInterval);
      const targetElem = responseBox[responseBox.length - 1];
      targetElem.innerHTML = "";
      const $errorBox = tag("div", { className: "error-box" });
      console.log(error)
      if (error.response) {
        $errorBox.innerText = `Status code: ${error.response.status}\n${JSON.stringify(error.response.data)}`;
      } else {
        $errorBox.innerText = `${error.message}`;
      }
      targetElem.appendChild($errorBox);
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
        loadingDots[loadingDots.length - 1].innerText += "•";
        if (loadingDots[loadingDots.length - 1].innerText == "••••••") {
          loadingDots[loadingDots.length - 1].innerText = "•";
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
      
      const aiPrompt = `Based on this description: "${description}"
      
      Suggest:
      1. Appropriate filename with extension
      2. Basic file structure/template
      3. Initial content
      
      Respond in JSON format:
      {
        "filename": "suggested_name.ext",
        "content": "file content here",
        "explanation": "why this structure"
      }`;
      
      const response = await this.getAiResponse(aiPrompt);
      
      try {
        const suggestion = JSON.parse(response);
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
          await fs(fullPath).writeFile(confirmCreate.content);
          window.toast(`File created: ${confirmCreate.filename}`, 3000);
          
          // Open the created file
          editorManager.addNewFile(confirmCreate.filename, {
            text: confirmCreate.content
          });
        }
      } catch (parseError) {
        // Fallback if JSON parsing fails
        const filename = await prompt("Enter filename:", "", "text", { required: true });
        if (filename) {
          const fullPath = basePath ? `${basePath}/${filename}` : filename;
          await fs(fullPath).writeFile(response);
          window.toast(`File created: ${filename}`, 3000);
        }
      }
    } catch (error) {
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
    Show diff between original and new content
    */
    try {
      // Simple diff implementation
      const originalLines = originalContent.split('\n');
      const newLines = newContent.split('\n');
      let diffHtml = `<div class="diff-container"><h4>Changes in ${filename}:</h4>`;
      
      const maxLines = Math.max(originalLines.length, newLines.length);
      
      for (let i = 0; i < maxLines; i++) {
        const origLine = originalLines[i] || '';
        const newLine = newLines[i] || '';
        
        if (origLine !== newLine) {
          if (origLine && newLine) {
            diffHtml += `<div class="diff-line modified"><span class="line-num">${i + 1}</span><span class="old-line">- ${origLine}</span><span class="new-line">+ ${newLine}</span></div>`;
          } else if (origLine && !newLine) {
            diffHtml += `<div class="diff-line deleted"><span class="line-num">${i + 1}</span><span class="old-line">- ${origLine}</span></div>`;
          } else if (!origLine && newLine) {
            diffHtml += `<div class="diff-line added"><span class="line-num">${i + 1}</span><span class="new-line">+ ${newLine}</span></div>`;
          }
        }
      }
      
      diffHtml += '</div>';
      return diffHtml;
    } catch (error) {
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
    const importRegex = /(?:import.*from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"])/g;
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
    
    let aiPrompt;
    if (selection) {
      aiPrompt = `Here's the selected code:\n\`\`\`\n${selection}\n\`\`\`\n\nUser request: ${userPrompt}\n\nPlease provide the improved/edited version of just the selected code.`;
    } else {
      aiPrompt = `Here's the full file content:\n\`\`\`\n${currentContent}\n\`\`\`\n\nUser request: ${userPrompt}\n\nPlease provide the complete improved file.`;
    }
    
    const response = await this.getAiResponse(aiPrompt);
    
    if (response) {
      // Extract code from response
      const codeMatch = response.match(/```[\w]*\n([\s\S]*?)\n```/);
      const newCode = codeMatch ? codeMatch[1] : response;
      
      // Show diff before applying
      const shouldApply = await this.showEditDiff(selection || currentContent, newCode, activeFile.name);
      
      if (shouldApply) {
        if (selection) {
          editor.replaceSelection(newCode);
        } else {
          editor.setValue(newCode);
        }
        
        window.toast("Code updated successfully!", 3000);
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
    const diffHtml = await this.showFileDiff(originalCode, newCode, filename);
    
    const dialog = tag("div", {
      className: "ai-edit-popup"
    });
    
    const header = tag("div", {
      className: "ai-edit-popup-header"
    });
    
    const title = tag("div", {
      className: "ai-edit-popup-title",
      textContent: "Review Changes"
    });
    
    header.appendChild(title);
    
    const body = tag("div", {
      className: "ai-edit-popup-body",
      innerHTML: diffHtml
    });
    
    const actions = tag("div", {
      className: "ai-edit-actions"
    });
    
    const cancelBtn = tag("button", {
      className: "ai-edit-btn secondary",
      textContent: "Cancel"
    });
    
    const applyBtn = tag("button", {
      className: "ai-edit-btn primary",
      textContent: "Apply Changes"
    });
    
    actions.append(cancelBtn, applyBtn);
    dialog.append(header, body, actions);
    document.body.appendChild(dialog);
    
    return new Promise((resolve) => {
      cancelBtn.onclick = () => {
        document.body.removeChild(dialog);
        resolve(false);
      };
      
      applyBtn.onclick = () => {
        document.body.removeChild(dialog);
        resolve(true);
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
  // Buka chat dan kirim prompt
  if (!this.$page.isVisible) {
    await this.run();
  }
  
  let fileContent = "";
  if (activeFile) {
    fileContent = editor.getValue();
  }
  
  const systemPrompt = `You are a professional code explainer. Analyze the provided code and explain it in detail, professionally, and comprehensively.`;
  const userPrompt = `Please explain this code in detail:

**File: ${activeFile ? activeFile.name : 'Unknown'}**

**Selected Code:**
\`\`\`
${selectedText}
\`\`\`

**Full File Content:**
\`\`\`
${fileContent}
\`\`\`

Please provide a detailed and professional explanation of what this code does, how it works, its dependencies, and any potential improvements.`;

  this.appendUserQuery(userPrompt);
  this.appendGptResponse("");
  this.loader();
  await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
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
    innerHTML: "×"
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
  popup.append(header, body); // PERBAIKAN: hapus actions dari sini
  
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
  
  const enhancedPrompt = `${systemPrompt}

**Current File: ${activeFile ? activeFile.name : 'New File'}**
**File Type: ${fileExtension}**

**Current File Content:**
\`\`\`
${fileContent}
\`\`\`

**User Request:** ${userPrompt}

Please generate the requested code. Consider:
1. Current file dependencies and imports
2. Existing code structure and patterns
3. Best practices for ${fileExtension} files
4. Proper error handling and optimization

Generate the code and insert it at the current cursor position.`;

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
  
  const userPrompt = `Please optimize this function:

\`\`\`
${selectedText}
\`\`\`

Provide optimized version with explanations of improvements made.`;

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
  
  const userPrompt = `Please add detailed comments to this code:

\`\`\`
${selectedText}
\`\`\`

Add comments explaining:
1. What each section does
2. Parameter descriptions
3. Return value explanations
4. Any complex logic`;

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
    
    const userPrompt = `Generate professional documentation for this code:

\`\`\`
${selectedText}
\`\`\`

Include JSDoc comments, usage examples, and API documentation.`;

    this.appendUserQuery(userPrompt);
    this.appendGptResponse("");
    this.loader();
    await this.getCliResponse(systemPrompt + "\n\n" + userPrompt);
  } else if (activeFile) {
    // Generate docs for entire file
    fullContent = editor.getValue();
    
    const systemPrompt = `You are a technical documentation expert. Generate comprehensive documentation for the entire file.`;
    
    const userPrompt = `Generate complete documentation for this file:

**File: ${activeFile.name}**

\`\`\`
${fullContent}
\`\`\`

Generate:
1. File overview and purpose
2. Function/class documentation
3. Usage examples
4. API reference
5. Dependencies and requirements`;

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
  
  async rewriteCodeWithChat(selectedText) {
  if (!this.$page.isVisible) {
    await this.run();
  }
  
  const systemPrompt = `You are a code refactoring expert. Rewrite the provided code to be cleaner, more efficient, and follow best practices while maintaining the same functionality.`;
  
  const userPrompt = `Please rewrite this code to be cleaner and more efficient:

\`\`\`
${selectedText}
\`\`\`

Provide the rewritten version with explanations of improvements made.`;

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
    window.toast("Real-time AI Assistant enabled ✨", 3000);
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
  
  statusElement.textContent = enabled ? "🤖 AI Active" : "";
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
  
  const prompt = `Analyze this ${fileExtension} code in real-time and provide suggestions:

**Current Line ${cursorPos.row + 1}:** ${currentLine}

**Full Code:**
\`\`\`${fileExtension}
${content}
\`\`\`

**Cursor Position:** Line ${cursorPos.row + 1}, Column ${cursorPos.column + 1}

Provide JSON response with:
{
  "syntax_errors": [{"line": number, "message": "error description", "severity": "error|warning"}],
  "missing_imports": ["import suggestions"],
  "code_suggestions": [{"line": number, "suggestion": "improvement suggestion", "type": "optimization|style|bug"}],
  "auto_complete": ["completion1", "completion2"],
  "quick_fixes": [{"line": number, "issue": "problem", "fix": "solution"}]
}

Focus on:
1. Syntax errors and missing imports
2. Code improvements at cursor position
3. Auto-completion suggestions
4. Quick fixes for common issues`;

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
    textContent: "×",
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

createSuggestionWidget() {
  this.suggestionWidget = tag("div", {
    className: "ai-suggestion-widget",
    style: `
      position: absolute;
      background: #1e1e1e;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 8px;
      max-width: 400px;
      z-index: 1000;
      display: none;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      color: #fff;
      font-family: monospace;
      font-size: 12px;
    `
  });
  
  document.body.appendChild(this.suggestionWidget);
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

applySuggestion(suggestion) {
  if (typeof suggestion === 'string') {
    editor.insert(suggestion);
  } else if (suggestion.type === 'completion') {
    editor.insert(suggestion.text);
  } else if (suggestion.type === 'replacement') {
    const range = suggestion.range || editor.getSelectionRange();
    editor.session.replace(range, suggestion.text);
  }
  
  window.toast("Applied AI suggestion", 1500);
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