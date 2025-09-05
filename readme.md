Renz Ai Cli
=========
> Advanced AI CLI assistant plugin

Renz Ai Cli plugin for Acode with advanced AI capabilities, file operations, and multi-provider support.

> Work in progress...

**Note:** This is beta version but features are kind off stable and usable.(But many stuffs are still missing check todo section)

## Supported Providers 

- [OpenAi](https://platform.openai.com/account/api-keys) 🙂
- [Google](https://makersuite.google.com/app/apikey) 😍
- [Ollama](https://ollama.com/) 😍
- [Groq](https://console.groq.com/keys) 😍
- [Mistral](https://mistral.ai/) 😕
- [Anthropic](https://www.anthropic.com/api) 😕
- OpenAI-Like Providers (Providers that use OpenAI style APIs to provide ai models, for example [Openrouter](https://openrouter.ai/)) 🙂

### Emoji Code Docs

- 😍 : Best and Recommended for beginners
- 🙂 : Costly
- 😕 : It will work but currently not added because I don't have key to test it.

## Usage (for contributors)

- Clone the repo
- `pnpm install`
- `pnpm build`
- then it will produce a `AI.zip`, just install it inside acode using local method 

Features
-----------

- User-friendly interface for easy communication with AI
- AI remembers previous responses to provide more personalized suggestions
- View Chat History
- Syntax highlighting and markdown styling, etc

## Todo

- [x] encrypt the api key and then save it securely 
- [x] Implement multiple model providers for increased versatility
- [x] Enhance history mechanism and introduce history context for AI interactions
- [x] Optimize history trimming to selectively share context without revealing entire history
- [x] Add user interface option for direct selection of model providers or specific models
- [ ] Integrate support for current file context to enhance AI responses
- [ ] Rewrite image generation feature to improve functionality and performance
- [ ] Implement quick access options directly within the editor interface
- [ ] Display available tokens and usage details in the chat interface
- [ ] Improve logging mechanism for better transparency and troubleshooting
- [x] Beautify and refactor codebase for improved readability and maintainability*

How to use:
-----------

To use AI Assistant, simply search for `"AI Assistant"` in the **command palette (<kbd>Ctrl-Shift-P</kbd>)** to open the chat interface. From there, you can communicate with the AI and receive helpful suggestions and solutions. 

First, it will prompt you for a passphrase (remember it), which will be used to securely save the API key.  
Then, it will ask you to select a provider and enter the API key for that provider.  
If you have selected OpenAI-Like provider then you will be asked to enter API base url.
It will then load the available models on your account, select the model and start the communication.  
If you have selected OpenAI-Like provider then it will not load models and you will be asked to enter the model manually, after which your configuration is done.  

**Note**: 
- You can change providers or models from the chat interface by using the triple vertical dots icon.
- If you want to use OpenAI-Like provider you need to refer to documentation of your provider for api base url and model.
- Currently only one provider can be specified in OpenAI-Like provider.

Contributing
-----------

If you're interested in contributing to the development of AI Assistant plugin, you can do so by submitting issues or pull requests. 

Checkout Todos and help in implementing those.

Contributers
-----------

<a href="https://github.com/RenzMc/acode-plugin-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=RenzMc/acode-plugin-cli" />
</a>