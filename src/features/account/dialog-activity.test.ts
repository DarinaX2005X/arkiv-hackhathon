import { expect, it } from 'vitest';
import { createDialogActivity } from './dialog-activity';

it('keeps guidance suspended until the last sign-in dialog closes without treating repeated cleanup as another close', () => {
  const activity = createDialogActivity(); let changes = 0;
  const unsubscribe = activity.subscribe(() => { changes++; });
  expect(activity.getSnapshot()).toBe(false);
  const closeFirst = activity.enter(), closeSecond = activity.enter();
  closeFirst(); closeFirst();
  expect(activity.getSnapshot()).toBe(true);
  closeSecond();
  expect(activity.getSnapshot()).toBe(false); expect(changes).toBe(4);
  unsubscribe(); activity.enter(); expect(changes).toBe(4);
});
