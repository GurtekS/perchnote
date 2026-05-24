import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import tippy, { Instance as TippyInstance } from "tippy.js";
import { filterItems, slashCommandItems, SlashCommandItem } from "./slashCommandItems";
import { SlashCommandList, SlashCommandListHandle } from "./SlashCommandList";

/**
 * Notion-style slash menu. Type "/" to insert a heading, list, callout,
 * etc. See `slashCommandItems.ts` for the full menu.
 */
export const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }: { query: string }) => filterItems(query),
        command: ({ editor, range, props }) => (props as SlashCommandItem).command({ editor, range }),
        render: () => {
          let component: ReactRenderer<SlashCommandListHandle> | null = null;
          let popup: TippyInstance | null = null;

          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashCommandList, {
                props: {
                  items: props.items as SlashCommandItem[],
                  command: (item: SlashCommandItem) => props.command(item),
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
                items: props.items as SlashCommandItem[],
                command: (item: SlashCommandItem) => props.command(item),
              });
              if (props.clientRect) {
                popup?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect });
              }
            },
            onKeyDown(props) {
              if (props.event.key === "Escape") {
                popup?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit() {
              popup?.destroy();
              component?.destroy();
            },
          };
        },
      }),
    ];
  },

  // Keep this so unused-warning doesn't fire on the import.
  addOptions() {
    return { items: slashCommandItems };
  },
});
