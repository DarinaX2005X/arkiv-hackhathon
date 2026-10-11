import type { Attestation, BookState, ContentHash, EntityKey } from './types';

export function effectiveOwnStatements(book: BookState): Attestation[] {
  const superseded = new Set(book.attestations.map(a => a.correctsAttestationId).filter((id): id is string => Boolean(id)));
  return book.attestations.filter(a => !superseded.has(a.id));
}

/** Replay the owner's admitted receipts. Excluding one plan reconstructs its opening custody. */
export function reconcileReturnedCustody(book: BookState, projectRoot: EntityKey, omitReturnPlan?: ContentHash): void {
  const statements = effectiveOwnStatements(book);
  const originalTime = (statement: Attestation): number => {
    let current = statement;
    const visited = new Set<string>();
    while (current.correctsAttestationId && !visited.has(current.id)) {
      visited.add(current.id);
      const prior = book.attestations.find(a => a.id === current.correctsAttestationId);
      if (!prior) break;
      current = prior;
    }
    return current.recordedAt;
  };
  const returned: { quantity: number; at: number; acknowledgement: Extract<Attestation, { kind: 'transfer_acknowledgement' }> }[] = [];
  const counted = new Set<string>();
  // These are the owner's retained assertions already admitted against the sender statement.
  // Losing another project's book must not reverse an already authored return acknowledgement.
  for (const ack of statements) {
    if (ack.kind !== 'transfer_acknowledgement' || ack.action !== 'return' || ack.projectRoot !== projectRoot
      || ack.author !== book.publisherRoot || ack.receiver !== book.publisherRoot || counted.has(ack.statementHash)
      || ack.proposalHash === omitReturnPlan) continue;
    counted.add(ack.statementHash);
    returned.push({ quantity: ack.acknowledgedQuantity, at: originalTime(ack), acknowledgement: ack });
  }
  returned.sort((a, b) => a.at - b.at || (a.acknowledgement.id < b.acknowledgement.id ? -1 : 1));
  const holds = book.custodyHolds.filter(h => h.projectRoot === projectRoot)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const hold of holds) {
    const sent = statements.find(a => a.id === hold.id && a.kind === 'transfer_report' && a.action === 'handover');
    if (sent?.kind !== 'transfer_report') continue;
    let releasedQuantity = 0;
    let lastAcknowledgement: Extract<Attestation, { kind: 'transfer_acknowledgement' }> | null = null;
    const explicitRelease = hold.status === 'released' && !hold.release?.acknowledgementId ? hold.release : undefined;
    for (const credit of returned) {
      if (credit.at < originalTime(sent) || credit.acknowledgement.resourceId !== sent.resourceId || credit.acknowledgement.giver !== sent.receiver) continue;
      if (explicitRelease && credit.at > explicitRelease.at) continue;
      const amount = Math.min(sent.quantity - releasedQuantity, credit.quantity);
      if (amount <= 0) continue;
      credit.quantity -= amount; releasedQuantity += amount; lastAcknowledgement = credit.acknowledgement;
    }
    // Earlier returned quantities cannot be borrowed by another handover, even after an explicit release.
    if (explicitRelease) continue;
    if (releasedQuantity === sent.quantity && lastAcknowledgement) {
      hold.quantity = sent.quantity;
      hold.status = 'released';
      hold.release = { at: lastAcknowledgement.recordedAt, operationId: lastAcknowledgement.operationId,
        reason: 'Owner acknowledged return', acknowledgementId: lastAcknowledgement.id };
    } else {
      hold.quantity = sent.quantity - releasedQuantity;
      hold.status = 'outstanding';
      delete hold.release;
    }
  }
}
