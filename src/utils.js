import { Ollama } from "ollama/browser";
import { AI_PROVIDERS, OPENAI_LIKE } from "./constants";

export async function getModelsFromProvider(provider, apiKey) {
  let modelList;
  try {
    switch (provider) {
      case AI_PROVIDERS[0]:
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
        modelList = openAIData.data
          .filter((item) => /gpt/i.test(item.id))
          .map((item) => item.id);
        break;

      case AI_PROVIDERS[1]:
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
          .filter((model) => /gemini/i.test(model.name))
          .map((model) => model.name.replace(/^models\//, ""));
        break;
      case AI_PROVIDERS[2]:
        let host = window.localStorage.getItem("Ollama-Host")
          ? window.localStorage.getItem("Ollama-Host")
          : "http://localhost:11434";
        const ollama = new Ollama({ host });
        const list = await ollama.list();
        modelList = list.models.map((item) => item.model);
        break;
      case AI_PROVIDERS[3]:
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
      case OPENAI_LIKE:
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