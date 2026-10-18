// Test-only Pi extension: a scripted offline model, `faux/faux-1`. It answers
// "Echo: <prompt>", or fails when the prompt contains "please fail". For a
// prompt containing "list files" it first thinks and calls `bash` with `ls`,
// then answers with the listing. No network, no credentials.
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

const textOf = (content: any): string =>
  typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join("");

function lastUserText(messages: any[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") return textOf(message.content);
  }
  return "";
}

export default function fauxModel(pi: any): void {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux One" }] });
  const reply = (context: any) => {
    const prompt = lastUserText(context.messages);
    const last = context.messages.at(-1);
    if (prompt.includes("please fail")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "The scripted model failed." });
    if (prompt.includes("list files")) {
      if (last?.role === "toolResult") return fauxAssistantMessage(`Files:\n${textOf(last.content).trim()}`);
      return fauxAssistantMessage([fauxThinking("A directory listing answers this."), fauxToolCall("bash", { command: "ls" }, { id: "call_ls" })], {
        stopReason: "toolUse",
      });
    }
    return fauxAssistantMessage(`Echo: ${prompt}`);
  };
  faux.setResponses(Array.from({ length: 20 }, () => reply));
  pi.registerProvider(faux.provider);
}
