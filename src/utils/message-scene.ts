/** Read a `key=value` entry from QQ `message_scene.ext`. */
export function findMessageSceneValue(ext: readonly string[] | undefined, key: string): string | null {
  const prefix = `${key}=`;
  const segment = ext?.find((item) => item.startsWith(prefix));
  return segment ? segment.slice(prefix.length) : null;
}
