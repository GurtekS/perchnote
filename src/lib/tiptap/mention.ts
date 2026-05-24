import Mention from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import tippy, { Instance as TippyInstance } from "tippy.js";
import { invoke } from "@tauri-apps/api/core";
import { MentionList, MentionListHandle } from "./MentionList";

export const MentionExtension = Mention.configure({
  HTMLAttributes: { class: "tiptap-mention" },
  renderText({ node }) {
    return `@${node.attrs.label ?? node.attrs.id}`;
  },
  renderHTML({ options, node }) {
    return [
      "span",
      { class: options.HTMLAttributes.class, "data-mention": "" },
      `@${node.attrs.label ?? node.attrs.id}`,
    ];
  },
  suggestion: {
    char: "@",
    items: async ({ query }) => {
      try {
        return await invoke<string[]>("list_mention_candidates", { prefix: query, limit: 8 });
      } catch {
        return [];
      }
    },
    render: () => {
      let component: ReactRenderer<MentionListHandle> | null = null;
      let popup: TippyInstance | null = null;

      return {
        onStart: (props) => {
          component = new ReactRenderer(MentionList, {
            props: {
              items: props.items as string[],
              command: (cmd: { id: string }) => props.command(cmd),
            },
            editor: props.editor,
          });
          if (!props.clientRect) return;
          popup = tippy(document.body, {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "bottom-start",
          });
        },
        onUpdate(props) {
          component?.updateProps({
            items: props.items as string[],
            command: (cmd: { id: string }) => props.command(cmd),
          });
          if (props.clientRect) {
            popup?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect });
          }
        },
        onKeyDown(props) {
          if (props.event.key === "Escape") { popup?.hide(); return true; }
          return component?.ref?.onKeyDown(props) ?? false;
        },
        onExit() {
          popup?.destroy();
          component?.destroy();
        },
      };
    },
  },
});
