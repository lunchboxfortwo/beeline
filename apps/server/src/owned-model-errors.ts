import { CommandRefusalError } from './command-refusal.js';

export class OwnedModelRefusal extends CommandRefusalError {
  constructor() { super('Owned model authority is unavailable', 403); }
}
