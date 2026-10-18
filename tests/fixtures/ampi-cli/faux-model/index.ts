// Test-only Pi extension: a scripted offline model, `faux/faux-1`. It answers
// "Echo: <prompt>", or fails when the prompt contains "please fail". No
// network, no credentials.
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

function lastUserText(messages: any[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("");
  }
  return "";
}

export default function fauxModel(pi: any): void {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux One" }] });
  const reply = (context: any) => {
    const prompt = lastUserText(context.messages);
    if (prompt.includes("please fail")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "The scripted model failed." });
    return fauxAssistantMessage(`Echo: ${prompt}`);
  };
  faux.setResponses(Array.from({ length: 20 }, () => reply));
  pi.registerProvider(faux.provider);
}
