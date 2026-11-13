import { roomHeaderFields, roomMemberFields, connectorOfferFields } from './phone-guards.js';
import type { Align } from './phone-view.js';
import type { ConnectorOfferCardView } from './connector-offers.js';
import type { RoomViewHeader, RoomViewMember } from './phone-types.js';

type Ok<Fields, Spec> = Align<Fields, Spec> extends Spec ? true : false;
function locks<T extends true>(): void {}

locks<Ok<RoomViewHeader, typeof roomHeaderFields>>();
locks<Ok<RoomViewMember, typeof roomMemberFields>>();
locks<Ok<ConnectorOfferCardView, typeof connectorOfferFields>>();
// @ts-expect-error a field with no reader
locks<Ok<RoomViewHeader & { notDeclared: true }, typeof roomHeaderFields>>();
// @ts-expect-error a reader with no field
locks<Ok<RoomViewHeader, typeof roomHeaderFields & { notDeclared: true }>>();
