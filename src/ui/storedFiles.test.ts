import { expect, test } from 'bun:test';
import { linkStoredFiles } from './storedFiles';

const url = (canvas: string, id: string, name: string) => `http://obeya/api/c/${canvas}/files/stored/${id}/${name}`;
const id = '0b8f3c1e-5d2a-4e7b-9c1d-2f3a4b5c6d7e';

test('a stored file stands in the conversation as a link named by the file', () => {
  expect(linkStoredFiles(`Read /home/me/.obeya/files/shop/${id}/pasted-text.txt, please.`, url)).toBe(`Read [pasted-text.txt](http://obeya/api/c/shop/files/stored/${id}/pasted-text.txt), please.`);
  // Windows, and a home with a space: the path stands in quotes
  expect(linkStoredFiles(`"C:\\Users\\Jo Doe\\.obeya\\files\\shop\\${id}\\message.txt"`, url)).toBe(`[message.txt](http://obeya/api/c/shop/files/stored/${id}/message.txt)`);
});

test('other paths and words stay as they are', () => {
  for (const text of ['src/files/shop/readme.md', '/home/me/files/shop/not-an-id/x.txt', 'He said "hello there" twice.']) expect(linkStoredFiles(text, url)).toBe(text);
});
