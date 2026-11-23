const endpoint = document.querySelector('meta[name="srb2-backend"]')?.content;

export const backend = new URL(endpoint || window.location.origin);
