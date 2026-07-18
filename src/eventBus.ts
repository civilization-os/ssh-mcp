import { EventEmitter } from "events";

// Global event bus for broadcasting state changes (Sessions, Shells, SFTP) to SSE clients.
export const globalEvents = new EventEmitter();
