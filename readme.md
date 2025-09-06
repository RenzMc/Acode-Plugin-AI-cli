# 🌌 Acode AI CLI Assistant Plugin

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/RenzMc/Acode-Plugin-AI-cli)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Android-brightgreen.svg)](https://acode.app)
[![AI Support](https://img.shields.io/badge/AI-Multi--Provider-purple.svg)](#supported-ai-providers)

> **Transform your mobile coding experience with the power of AI** ✨

An advanced AI-powered coding assistant plugin for Acode (Android Code Editor) that brings intelligent code assistance, real-time analysis, and comprehensive project management directly to your mobile development workflow.

![Acode AI CLI Preview](dist/assets/user_avatar.png)

## 🚀 Features

### 🤖 **Multi-Provider AI Support**
- **OpenAI GPT** - Industry-leading language models
- **Google Gemini** - Advanced reasoning and code understanding
- **Ollama** - Local AI models for privacy
- **Groq** - Lightning-fast inference
- **Anthropic Claude** - Exceptional code analysis
- **OpenRouter** - Access to multiple providers
- **Qwen** - Alibaba's powerful language models
- **OpenAI-Like** - Compatible with any OpenAI-like API

### 💫 **Real-Time AI Features**
- **Live Code Analysis** - Get instant feedback as you type
- **Smart Error Detection** - Catch bugs before they happen
- **Context-Aware Suggestions** - Intelligent code completion
- **Performance Optimization** - Automatic caching and debouncing

### 🛠️ **Bulk Operations**
- **Multi-File Renaming** - Rename multiple files with patterns
- **File Organization** - Move files to appropriate folders
- **Header Management** - Add consistent headers to all files
- **Format Conversion** - Convert between file formats
- **Cleanup Tools** - Remove unused files automatically

### 📁 **Project Management**
- **Structure Analysis** - AI-powered project organization
- **Architecture Suggestions** - Best practices recommendations
- **File Categorization** - Automatic folder structure creation
- **Dependency Management** - Track and optimize dependencies

### 🎨 **Galaxy-Themed UI**
- **Stunning Visuals** - Beautiful galaxy background with animations
- **Responsive Design** - Perfect on all device orientations
- **Acode Theme Integration** - Seamlessly adapts to your theme
- **Smooth Animations** - Fluid interactions and transitions

### 🔒 **Security & Privacy**
- **Encrypted API Keys** - AES-GCM encryption with PBKDF2
- **Local Storage** - Your data stays on your device
- **Secure Communication** - HTTPS-only API calls
- **No Data Collection** - Privacy-first approach

## 📱 Installation

### Method 1: From Acode Plugin Store
1. Open **Acode** app on your Android device
2. Go to **Settings** → **Plugins**
3. Search for **"AI CLI Assistant"**
4. Tap **Install** and **Enable**

### Method 2: Manual Installation
1. Download the latest `acode-ai-cli.zip` from [Releases](https://github.com/RenzMc/Acode-Plugin-AI-cli/releases)
2. Open **Acode** → **Settings** → **Plugins**
3. Tap **Install from ZIP/Local**
4. Select the downloaded file
5. Enable the plugin
6. Restart Acode app

### Method 3: Development Build
```bash
git clone https://github.com/RenzMc/Acode-Plugin-AI-cli.git
cd Acode-Plugin-AI-cli
npm install
npm run build
```

## ⚙️ Setup & Configuration

### 1. **Initial Setup**
1. Open Acode and enable the AI CLI Assistant plugin
2. The AI assistant will appear in your sidebar
3. Configure your preferred AI provider

### 2. **API Keys Configuration**
Configure your AI provider credentials:

#### OpenAI
```
API Key: your-openai-api-key
Model: gpt-4, gpt-3.5-turbo, etc.
```

#### OpenRouter
```
API Key: your-openrouter-api-key
Model: available all open router models
```

#### Google Gemini
```
API Key: your-gemini-api-key
Model: gemini-pro, gemini-1.5-pro, etc.
```

#### Anthropic Claude
```
API Key: your-anthropic-api-key
Model: claude-3-opus, claude-3-sonnet, etc.
```

#### Groq
```
API Key: your-groq-api-key
Model: llama3-70b-8192, mixtral-8x7b-32768, etc.
```

#### Qwen
```
API Key: your-qwen-api-key
Model: qwen-turbo, qwen-plus, qwen-max, etc.
```

#### Ollama (Local)
```
Endpoint: http://localhost:11434
Model: llama2, codellama, mistral, etc.
```

### 3. **Theme Integration**
The plugin automatically adapts to your Acode theme:
- **Dark Mode**: Full galaxy theme with cosmic effects
- **Light Mode**: Softened galaxy theme with light colors
- **Auto Mode**: Follows system preference

## 🎯 Usage Guide

### 💬 **Basic Chat**
1. Open the Renz Ai using Ctrl/Cmd + Shift + A
2. Type your coding question or request
3. Get instant AI-powered responses
4. Copy code snippets with one tap

### ⚡ **Real-Time Analysis**
- **Auto-enabled** when editing files
- Get suggestions as you type
- Instant error detection
- Performance optimization tips

### 🔁 **Bulk Operations**
1. Tap the **bulk operations** icon
2. Choose your operation:
   - **Rename Files**: Use patterns like `component_{index}.js`
   - **Move Files**: Organize into proper folders
   - **Add Headers**: Consistent file headers
   - **Format Conversion**: Convert between file types
3. Select files and follow prompts

### 📊 **Project Organization**
1. Tap **Organize Project** in the menu
2. AI analyzes your project structure
3. Get recommendations for:
   - Better folder organization
   - File categorization
   - Architecture improvements
   - Cleanup suggestions

## 🔧 Advanced Features

### **Custom Prompts**
Create reusable prompts for common tasks:
```javascript
// Add to your prompt library
"Optimize this React component for performance"
"Add TypeScript types to this function"
"Create unit tests for this module"
```

### **Context Menu Integration**
- Right-click any code selection
- Choose **"Ask AI"** for instant analysis
- Get context-aware suggestions

## 🎨 Customization

### **Theme Customization**
The plugin respects Acode's theming system and can be further customized:

```scss
// Override galaxy colors
:root {
  --galaxy-star-blue: #your-color;
  --galaxy-star-purple: #your-color;
  --galaxy-nebula: #your-color;
}
```

### **Performance Settings**
Adjust real-time analysis sensitivity:
- **High**: Instant feedback (more API calls)
- **Medium**: 5-second debounce (balanced)
- **Low**: 10-second debounce (fewer API calls)

## 📐 Responsive Design

Perfect experience across all devices:
- **📱 Mobile Portrait**: Optimized for phones
- **📱 Mobile Landscape**: Adapted for landscape typing
- **📚 Tablet Portrait**: Enhanced for larger screens
- **📚 Tablet Landscape**: Full desktop-like experience
- **🖥️ Desktop**: Complete feature set

## 🔐 Security & Privacy

### **Data Protection**
- **Local Encryption**: API keys encrypted with AES-GCM
- **No Tracking**: Zero telemetry or analytics
- **Private Conversations**: Chat history stays local
- **Secure APIs**: HTTPS-only communication

### **API Key Security**
- Keys are encrypted before storage
- Uses PBKDF2 with 100,000 iterations
- Random initialization vectors
- Automatic key rotation support

## 🐛 Troubleshooting

### **Common Issues**

#### Plugin Not Loading
```bash
# Check Acode version compatibility
Minimum Acode version: 1.8.0
```

#### API Connection Failed
1. Verify API key is correct
2. Check internet connection
3. Ensure endpoint URL is valid
4. Try switching AI providers

#### Real-Time Analysis Not Working
1. Enable the feature in settings
2. Check file type support
3. Verify API quota limits
4. Restart the plugin

#### UI Not Responsive
1. Clear plugin cache
2. Restart Acode app
3. Check device memory
4. Disable hardware acceleration

### **Performance Optimization**
- **Cache Management**: Automatic 5-minute cache expiry
- **Token Optimization**: Smart content filtering
- **Memory Usage**: Efficient cleanup and debouncing
- **Battery Saving**: Reduced animations on low battery

## 🤝 Contributing

We welcome contributions! Here's how to get started:

### **Development Setup**
```bash
git clone https://github.com/RenzMc/Acode-Plugin-AI-cli.git
cd Acode-Plugin-AI-cli
npm install
npm run dev
```

### **Build Process**
```bash
npm run build        # Production build
npm run dev          # Development build
npm run watch        # Watch mode
npm run test         # Run tests
```

### **Code Style**
- Follow ESLint configuration
- Use Prettier for formatting
- Write JSDoc comments
- Add unit tests for new features

### **Submitting Changes**
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 🗺️ Roadmap

### **Version 2.1.0** (Coming Soon)
- [ ] Voice commands support
- [ ] Advanced code refactoring tools
- [ ] Git integration
- [ ] Multi-language support

### **Version 3.0.0** (Planned)
- [ ] Collaborative coding features
- [ ] Plugin marketplace
- [ ] Custom AI model training
- [ ] Advanced debugging tools

### **Version 4.0.0** (Future)
- [ ] Cloud sync
- [ ] Team collaboration
- [ ] Enterprise features

## 📈 Stats & Performance

- **⚡ Response Time**: < 2 seconds average
- **💾 Memory Usage**: < 50MB typical
- **🔋 Battery Impact**: Minimal (< 2% per hour)
- **✅ Success Rate**: 99.5% API reliability
- **🌎 Languages**: 50+ programming languages supported

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Acode Team** for the amazing mobile editor
- **LangChain** for AI abstractions
- **OpenAI, Google, Anthropic** for AI services
- **Contributors** who make this project better
- **Community** for feedback and suggestions

## 📞 Support

### **Get Help**
- 📚 [Wiki Documentation](https://github.com/RenzMc/Acode-Plugin-AI-cli/wiki)
- 🐛 [Report Issues](https://github.com/RenzMc/Acode-Plugin-AI-cli/issues)
- 💬 [Discussions](https://github.com/RenzMc/Acode-Plugin-AI-cli/discussions)
- 📧 [Contact Developer](mailto:renzaja11@gmail.com)

### **Community**
- ⭐ Star this repo if you find it helpful
- 🍴 Fork and contribute
- 📢 Share with fellow developers
- 💖 Consider sponsoring

---

<div align="center">

**Made with ❤️ by [RenzMc](https://github.com/RenzMc)**

*Transforming mobile development, one line of code at a time* 🚀

[⬆ Back to Top](#-acode-ai-cli-assistant-plugin)

</div>
