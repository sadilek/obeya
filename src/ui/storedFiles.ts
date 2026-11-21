// Files Obeya keeps for the owner's messages (a dropped file it found nowhere on its machine, a
// pasted text too long for a message) stand in a message by their path, `…/files/<canvas>/<id>/<name>`,
// for the agent to read. In the conversation each shows as a link named by the file, which opens it.

const STORED = /^"?(?:.*[\\/])?files[\\/]([^\\/\s"]+)[\\/]([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})[\\/]([\p{L}\p{N}._-]+?)"?([.,;:!?)]*)$/u;

/**
 * `text` with the path of each stored file as a markdown link to `url(canvas, id, name)`, named by
 * the file; a path with a space stands in quotes, as the field puts it in.
 */
export const linkStoredFiles = (text: string, url: (canvas: string, id: string, name: string) => string) =>
  text.replace(/"[^"\n]*"\S*|\S+/g, (word) => {
    const m = STORED.exec(word);
    return m ? `[${m[3]}](${url(m[1]!, m[2]!, m[3]!)})${m[4]}` : word;
  });
