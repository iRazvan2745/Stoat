import type { AppRouterClient } from "@stoat/api/routers/index";
import type { RequestLogger } from "evlog";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  var $client: AppRouterClient | undefined;

  namespace App {
    // interface Error {}
    interface Locals {
      log: RequestLogger;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
