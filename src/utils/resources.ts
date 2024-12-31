import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { parseNote, extractTags } from "./tags.js";
import { getAllMarkdownFiles, safeReadFile } from "./files.js";
import { normalizePath, safeJoinPath } from "./path.js";

export interface VaultResource {
  uri: string;
  name: string;
  mimeType: string;
  description?: string;
  metadata?: {
    path: string;
    noteCount: number;
    lastModified: Date;
    tags: string[];
    isAccessible: boolean;
  };
}

export interface VaultListResource {
  uri: string;
  name: string;
  mimeType: string;
  description: string;
  metadata?: {
    totalVaults: number;
    vaults: Array<{
      name: string;
      path: string;
      isAccessible: boolean;
    }>;
  };
}

export interface NoteResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * Extracts links from note content
 */
function extractLinks(content: string): string[] {
  const links = new Set<string>();
  
  // Match both wikilinks [[Note]] and markdown links [Note](Note.md)
  const WIKILINK_PATTERN = /\[\[([^\]]+?)(\|[^\]]+)?\]\]/g;
  const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+\.md)\)/g;
  
  // Extract wikilinks
  let match;
  while ((match = WIKILINK_PATTERN.exec(content)) !== null) {
    links.add(match[1].split('|')[0].trim());
  }
  
  // Extract markdown links
  while ((match = MARKDOWN_LINK_PATTERN.exec(content)) !== null) {
    const linkPath = match[2];
    const noteName = path.basename(linkPath, '.md');
    links.add(noteName);
  }
  
  return Array.from(links);
}

interface NoteMetadata {
  title: string;
  path: string;
  tags: string[];
  frontmatter: Record<string, any>;
  links: string[];
  lastModified: Date;
  created?: Date;
}

/**
 * Gets metadata for a note
 */
async function getNoteMetadata(notePath: string): Promise<NoteMetadata> {
  const content = await safeReadFile(notePath);
  if (!content) {
    throw new McpError(ErrorCode.InvalidRequest, `Note not found: ${notePath}`);
  }

  const stats = await fs.stat(notePath);
  const parsed = parseNote(content);
  const links = extractLinks(content);
  const inlineTags = extractTags(parsed.content);
  const frontmatterTags = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [];
  
  // Combine and deduplicate tags
  const allTags = [...new Set([...inlineTags, ...frontmatterTags])];

  return {
    title: path.basename(notePath, '.md'),
    path: notePath,
    tags: allTags,
    frontmatter: parsed.frontmatter,
    links,
    lastModified: stats.mtime,
    created: stats.birthtime
  };
}

/**
 * Gets metadata for a vault
 */
export async function getVaultMetadata(vaultPath: string): Promise<{
  noteCount: number;
  lastModified: Date;
  tags: string[];
}> {
  const files = await getAllMarkdownFiles(vaultPath);
  let lastModified = new Date(0);
  const allTags = new Set<string>();
  
  for (const file of files) {
    try {
      const metadata = await getNoteMetadata(file);
      if (metadata.lastModified > lastModified) {
        lastModified = metadata.lastModified;
      }
      metadata.tags.forEach(tag => allTags.add(tag));
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
    }
  }

  return {
    noteCount: files.length,
    lastModified,
    tags: Array.from(allTags)
  };
}

/**
 * Lists vault resources including a root resource that lists all vaults
 */
export async function listVaultResources(vaults: Map<string, string>): Promise<(VaultResource | VaultListResource)[]> {
  const resources: (VaultResource | VaultListResource)[] = [];

  // Add root resource that lists all vaults
  const vaultList: VaultListResource = {
    uri: "obsidian-vault://",
    name: "Available Vaults",
    mimeType: "application/json",
    description: "List of all available Obsidian vaults and their access status",
    metadata: {
      totalVaults: vaults.size,
      vaults: []
    }
  };

  // Process each vault
  for (const [vaultName, vaultPath] of vaults.entries()) {
    try {
      const metadata = await getVaultMetadata(vaultPath);
      const isAccessible = true; // We can add actual accessibility checks here if needed

      // Add to vault list
      vaultList.metadata?.vaults.push({
        name: vaultName,
        path: vaultPath,
        isAccessible
      });

      // Add individual vault resource
      resources.push({
        uri: `obsidian-vault://${vaultName}`,
        name: vaultName,
        mimeType: "application/json",
        description: `Metadata and statistics for the ${vaultName} vault`,
        metadata: {
          path: vaultPath,
          ...metadata,
          isAccessible
        }
      });
    } catch (error) {
      console.error(`Error processing vault ${vaultName}:`, error);
      // Still add to vault list but mark as inaccessible
      vaultList.metadata?.vaults.push({
        name: vaultName,
        path: vaultPath,
        isAccessible: false
      });
    }
  }

  // Add vault list as first resource
  resources.unshift(vaultList);

  return resources;
}

/**
 * Gets available resource templates
 */
export function getNoteResourceTemplates(): NoteResourceTemplate[] {
  return [
    {
      uriTemplate: "obsidian-vault://",
      name: "List all vaults",
      description: "Get a list of all available vaults and their access status",
      mimeType: "application/json"
    },
    {
      uriTemplate: "obsidian-vault://{vault}",
      name: "Vault metadata",
      description: "Access metadata and statistics for a specific vault",
      mimeType: "application/json"
    }
  ];
}

/**
 * Reads a vault resource by URI
 */
export async function readVaultResource(
  vaults: Map<string, string>,
  uri: string
): Promise<{ uri: string; mimeType: string; text: string }> {
  const vaultName = uri.replace("obsidian-vault://", "");
  const vaultPath = vaults.get(vaultName);

  if (!vaultPath) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Unknown vault: ${vaultName}`
    );
  }

  const metadata = await getVaultMetadata(vaultPath);

  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify({
      name: vaultName,
      path: vaultPath,
      ...metadata
    }, null, 2)
  };
}
