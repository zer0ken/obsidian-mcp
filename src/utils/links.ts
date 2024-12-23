import { promises as fs } from "fs";
import path from "path";
import { getAllMarkdownFiles } from "./files.js";

/**
 * Updates markdown links in a file
 * @returns true if any links were updated
 */
export async function updateLinksInFile(
  filePath: string,
  oldPath: string,
  newPath: string | null // null for deletion
): Promise<boolean> {
  const content = await fs.readFile(filePath, "utf-8");
  
  const oldName = path.basename(oldPath, ".md");
  const newName = newPath ? path.basename(newPath, ".md") : null;
  
  let newContent: string;
  
  if (newPath === null) {
    // Handle deletion - strike through the links
    newContent = content
      .replace(
        new RegExp(`\\[\\[${oldName}(\\|[^\\]]*)?\\]\\]`, "g"),
        `~~[[${oldName}$1]]~~`
      )
      .replace(
        new RegExp(`\\[([^\\]]*)\\]\\(${oldName}\\.md\\)`, "g"),
        `~~[$1](${oldName}.md)~~`
      );
  } else {
    // Handle move/rename - update the links
    newContent = content
      .replace(
        new RegExp(`\\[\\[${oldName}(\\|[^\\]]*)?\\]\\]`, "g"),
        `[[${newName}$1]]`
      )
      .replace(
        new RegExp(`\\[([^\\]]*)\\]\\(${oldName}\\.md\\)`, "g"),
        `[$1](${newName}.md)`
      );
  }

  if (content !== newContent) {
    await fs.writeFile(filePath, newContent, "utf-8");
    return true;
  }
  
  return false;
}

/**
 * Updates all markdown links in the vault after a note is moved or deleted
 * @returns number of files updated
 */
export async function updateVaultLinks(
  vaultPath: string,
  oldPath: string,
  newPath: string | null // null for deletion
): Promise<number> {
  const files = await getAllMarkdownFiles(vaultPath);
  let updatedFiles = 0;

  for (const file of files) {
    // Skip the target file itself if it's a move operation
    if (newPath && file === path.join(vaultPath, newPath)) continue;
    
    if (await updateLinksInFile(file, oldPath, newPath)) {
      updatedFiles++;
    }
  }

  return updatedFiles;
}
