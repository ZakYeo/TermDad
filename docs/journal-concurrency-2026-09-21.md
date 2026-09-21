# Event journal concurrency investigation

The performance baseline reported 14 unique sequences for 20 successful
publishes. Forty isolated runs of the existing concurrent-writer test passed;
that did not disprove the race. A controlled filesystem interleaving reproduced
actual event loss independently of performance changes: both publishers returned
sequence 1, but reopening the journal found only the first publisher's event.

The interleaving is:

1. A contender sees `events.lock` and starts checking whether it is stale.
2. The previous holder releases it; the check's read fails with ENOENT.
3. Another publisher acquires the path and reads the journal.
4. The failed read resolves. `lockIsStale` interpreted ENOENT as true, so the
   contender unlinked the new publisher's lock and entered the transaction too.
5. Both transactions chose the same next sequence; the last rename lost the
   other publisher's successfully returned event.

`tests/journal-race.test.ts` controls that ordering at the filesystem boundary,
pausing a real publisher before rename. Before the fix, its exclusion assertion
failed with `Missing expected rejection`. The independent diagnostic also
compared returned sequences and persisted pane IDs, confirming loss rather than
merely duplicate response metadata. This is a confirmed loss mechanism consistent
with the intermittent failure; the original suite run did not capture its exact
interleaving.

The fix treats an absent lock as unavailable for reclamation. Normal acquisition
can retry its exclusive create, using existing bounded contention handling.
Assertions and retry counts are unchanged. Reclamation's own guard no longer
self-reclaims or expires on a timer: two reclaimers must never remove one
another's live guard. A crashed `reclaim.lock` fails closed for reclamation;
normal exclusive acquisition of an absent transaction lock still works.

For a leftover reclamation guard, stop every process using that state directory,
verify there are no active holders, then remove `reclaim.lock` explicitly before
restarting. Never remove it merely because it is old. Ordinary dead-holder
transaction and worker locks retain automatic recovery.
