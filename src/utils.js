import { Ollama } from "ollama/browser";
import { AI_PROVIDERS, OPENAI_LIKE, OPENROUTER, QWEN } from "./constants";

export async function getModelsFromProvider(provider, apiKey) {
  let modelList;
  try {
    switch (provider) {
      case AI_PROVIDERS[0]: // OpenAI
        const openAIResponse = await fetch("https://api.openai.com/v1/models", {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        });

        if (!openAIResponse.ok) {
          acode.alert(
            "AI Assistant",
            `Error fetching OpenAI models: ${openAIResponse.statusText}`,
          );
          throw new Error(
            `Error fetching OpenAI models: ${openAIResponse.statusText}`,
          );
        }

        const openAIData = await openAIResponse.json();
        // filter only gpt realted models
        modelList = openAIData.data
          .filter((item) => /gpt/i.test(item.id))
          .map((item) => item.id);
        break;

      case AI_PROVIDERS[1]: // Google AI
        const googleAIResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
          {
            headers: {
              "Content-Type": "application/json",
            },
          },
        );

        if (!googleAIResponse.ok) {
          acode.alert(
            "AI Assistant",
            `Error fetching Google AI models: ${googleAIResponse.statusText}`,
          );
          throw new Error(
            `Error fetching Google AI models: ${googleAIResponse.statusText}`,
          );
        }

        const googleAIData = await googleAIResponse.json();
        modelList = googleAIData.models
          .filter((model) => /gemini/i.test(model.name)) // Filter models containing "gemini"
          .map((model) => model.name.replace(/^models\//, "")); // Remove "models/" prefix

        break;
      case AI_PROVIDERS[2]: // ollama
        // check local storage, if user want to provide custom host for ollama
        let host = window.localStorage.getItem("Ollama-Host")
          ? window.localStorage.getItem("Ollama-Host")
          : "http://localhost:11434";
        const ollama = new Ollama({ host });
        const list = await ollama.list();
        modelList = list.models.map((item) => item.model);
        break;

      case AI_PROVIDERS[3]: // Groq
        const groqAIResponse = await fetch(
          `https://api.groq.com/openai/v1/models`,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
          },
        );

        if (!groqAIResponse.ok) {
          acode.alert(
            "AI Assistant",
            `Error fetching Groq AI models: ${groqAIResponse.statusText}`,
          );
          throw new Error(
            `Error fetching Groq AI models: ${groqAIResponse.statusText}`,
          );
        }

        const groqAIData = await groqAIResponse.json();
        modelList = groqAIData.data.map((item) => item.id);
        break;

      case AI_PROVIDERS[4]: // OpenRouter
        const openRouterResponse = await fetch("https://openrouter.ai/api/v1/models", {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        });

        if (!openRouterResponse.ok) {
          acode.alert(
            "AI Assistant",
            `Error fetching OpenRouter models: ${openRouterResponse.statusText}`,
          );
          throw new Error(
            `Error fetching OpenRouter models: ${openRouterResponse.statusText}`,
          );
        }

        const openRouterData = await openRouterResponse.json();
        modelList = openRouterData.data.map((item) => item.id);
        break;

      case AI_PROVIDERS[5]: // Qwen
        // Qwen models through Alibaba Cloud or compatible providers
        modelList = [
          "qwen-turbo",
          "qwen-plus",
          "qwen-max",
          "qwen-max-longcontext",
          "qwen-7b-chat",
          "qwen-14b-chat",
          "qwen-72b-chat",
          "qwen2.5-coder-32b-instruct"
        ];
        break;
        
      case OPENAI_LIKE: // OpenAI-Like
        // Return empty array because we do not fetch models for this
        return [];

      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  } catch (error) {
    console.error(error.message);
    return [];
  }

  return modelList;
}
