export function localServiceUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The VoxShop service returned no address.');
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/'
  )
    throw new Error('The VoxShop service returned an invalid local address.');
  return url.origin;
}
