import type { PhoneService } from '../phone-service.js';
export type PhoneContext = PhoneService;

/** Handler arguments after the service context; handler defaults stay authoritative. */
export type PhoneArguments<Handler> = Handler extends (...args: infer Args) => unknown
  ? Args extends [unknown, ...infer Rest] ? Rest : never
  : never;
