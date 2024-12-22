import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export const CreateNoteSchema = z.object({
  filename: z.string(),
  content: z.string(),
  folder: z.string().optional()
});

async function createNote(vaultPath: string, filename: string, content: string, folder?: string): Promise<string> {
  if (!filename.endsWith(".md")) {
    filename = `${filename}.md`;
  }

  const notePath = folder 
    ? path.join(vaultPath, folder, filename)
    : path.join(vaultPath, filename);

  const noteDir = path.dirname(notePath);
  await fs.mkdir(noteDir, { recursive: true });

  try {
    await fs.access(notePath);
    // Note exists - provide helpful information about next steps
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Note already exists at: ${notePath}\n\nTo modify this note, you can use the edit-note tool with these operations:\n- append: Add content to the end\n- prepend: Add content to the beginning\n- replace: Replace entire content\n- delete: Delete the note`
    );
  } catch (error: any) {
    if (error.code === "ENOENT") {
      await fs.writeFile(notePath, content);
      return notePath;
    }
    throw error;
  }
}

export function createCreateNoteTool(vaultPath: string): Tool {
  return {
    name: "create-note",
    description: "Create a new note in the vault",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Name of the note (with .md extension)"
        },
        content: {
          type: "string",
          description: "Content of the note in markdown format"
        },
        folder: {
          type: "string",
          description: "Optional subfolder path"
        }
      },
      required: ["filename", "content"]
    },
    handler: async (args) => {
      const { filename, content, folder } = CreateNoteSchema.parse(args);
      const notePath = await createNote(vaultPath, filename, content, folder);
      return {
        content: [
          {
            type: "text",
            text: `Successfully created note: ${notePath}`
          }
        ]
      };
    }
  };
}
