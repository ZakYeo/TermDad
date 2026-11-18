import { z } from 'zod';
import type { EventFilter } from './events.js';
import { CodedError } from './errors.js';
export function validateGroupFilter(groupId: string, filter: EventFilter) {
  if (!z.uuid().safeParse(groupId).success)
    throw new CodedError('SUPERVISION_FILTER_INVALID', 'groupId must be a UUID');
  if (Object.entries(filter).some(([key, value]) => key !== 'kinds' && value !== undefined))
    throw new CodedError(
      'SUPERVISION_FILTER_INVALID',
      'Group mode accepts kinds only; membership is dynamic and pending events have no sequence cursor',
    );
}
