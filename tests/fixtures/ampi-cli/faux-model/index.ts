// Test-only Pi extension: a scripted offline model, `faux/faux-1`. It answers
// "Echo: <prompt>", or fails when the prompt contains "please fail". For a
// prompt containing "list files" it first thinks and calls `bash` with `ls`,
// then answers with the listing. For "read file <path>" it calls Pi's `read`
// tool with that path, then answers "Read it."; a compaction summary request,
// whose prompt starts with "<conversation>" or "# Conversation" and may quote
// such a prompt, gets the echo instead. For "wait on <fifo>" it calls `bash`
// with `cat <fifo>`, which blocks until something writes the FIFO, then answers
// "Waited: <output>". For a prompt starting with "run: <command>" it calls
// `bash` with that command, then answers "Ran: <output>". A message containing
// "release <fifo>" writes that FIFO when Pi receives it, before Pi queues the
// message, so a steering message can end such a wait without any timing. A
// prompt containing "review with checks" calls `reviewer` on the uncommitted
// changes and then answers with the headings of its report. A reviewer child
// (its task text contains "Review the following diff:") answers with a clean
// report in the reviewer's format, or with one finding at `<path>:1-1` when the
// task text contains "faux-finding <path>"; a review check whose body says
// "please fail" fails like any other prompt that does. A prompt containing
// "view media <path>" calls `view_media` with that path and a fixed objective,
// then answers with the tool result's text. A media worker child (its task text
// lists "Images to read") calls `read` on the first listed path, then answers
// with a fixed sentence saying whether the read result held an image block.
// No network, no credentials.
import { writeFile } from "node:fs";
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
    const read = /read file (\S+)/.exec(prompt);
    // Not in a compaction summary request, which quotes the conversation:
    // "<conversation>" opens the history summary, "# Conversation" the summary
    // of a split turn's prefix.
    if (read && !prompt.startsWith("<conversation>") && !prompt.startsWith("# Conversation")) {
      if (last?.role === "toolResult") return fauxAssistantMessage("Read it.");
      return fauxAssistantMessage(fauxToolCall("read", { path: read[1] }, { id: `call_read_${context.messages.length}` }), {
        stopReason: "toolUse",
      });
    }
    if (prompt.includes("review with checks")) {
      if (last?.role === "toolResult") {
        const headings = textOf(last.content).split("\n").filter((line) => line.startsWith("### "));
        return fauxAssistantMessage(`Review finished.\n${headings.map((line) => `- ${line.slice(4)}`).join("\n")}`);
      }
      return fauxAssistantMessage(fauxToolCall("reviewer", { diff_description: "uncommitted changes" }, { id: "call_review" }), {
        stopReason: "toolUse",
      });
    }
    if (prompt.includes("Images to read (absolute paths")) {
      if (last?.role === "toolResult") {
        const sawImage = Array.isArray(last.content) && last.content.some((part: any) => part.type === "image");
        return fauxAssistantMessage(sawImage ? "The media worker saw an image block in the read result." : "The media worker found no image block in the read result.");
      }
      const first = /^1\. (.+) \(image\/[a-z]+\)$/m.exec(prompt);
      return fauxAssistantMessage(fauxToolCall("read", { path: first?.[1] ?? "" }, { id: "call_media_read" }), { stopReason: "toolUse" });
    }
    const media = /view media (\S+)/.exec(prompt);
    if (media) {
      if (last?.role === "toolResult") return fauxAssistantMessage(textOf(last.content).trim());
      return fauxAssistantMessage(fauxToolCall("view_media", { paths: [media[1]], objective: "Describe what the image shows." }, { id: "call_view_media" }), {
        stopReason: "toolUse",
      });
    }
    if (prompt.includes("Review the following diff:")) {
      const finding = /faux-finding (\S+)/.exec(prompt);
      if (finding) {
        return fauxAssistantMessage(
          `The change needs one fix.\n\nFindings\n- ${finding[1]}:1-1 — severity: medium; type: bug\n  The scripted reviewer flags this line.`,
        );
      }
      return fauxAssistantMessage("The change looks clean.\n\nFindings\n\nNone.");
    }
    const run = /^run: (.+)$/s.exec(prompt);
    if (run) {
      if (last?.role === "toolResult") return fauxAssistantMessage(`Ran: ${textOf(last.content).trim()}`);
      return fauxAssistantMessage(fauxToolCall("bash", { command: run[1] }, { id: "call_run" }), { stopReason: "toolUse" });
    }
    const wait = /wait on (\S+)/.exec(prompt);
    if (wait) {
      if (last?.role === "toolResult") return fauxAssistantMessage(`Waited: ${textOf(last.content).trim()}`);
      return fauxAssistantMessage(fauxToolCall("bash", { command: `cat ${wait[1]}` }, { id: "call_wait" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(`Echo: ${prompt}`);
  };
  faux.setResponses(Array.from({ length: 20 }, () => reply));
  pi.registerProvider(faux.provider);

  pi.on("input", (event: any) => {
    const release = /release (\S+)/.exec(event.text);
    // Asynchronous, so Pi queues the message before the waiting command can finish.
    if (release) writeFile(release[1], "released\n", () => {});
  });
}
