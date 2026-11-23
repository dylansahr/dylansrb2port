const relayOrigin = document.querySelector('meta[name="srb2-relay"]')?.content;

export const hostedOnPages = Boolean(relayOrigin);
export const backend = new URL(relayOrigin || window.location.origin);
