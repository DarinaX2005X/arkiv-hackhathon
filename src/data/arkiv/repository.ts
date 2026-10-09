import type { Actor, EntityKey } from '../../domain/types';
import { validateRecipe } from '../../domain/validation';
import { deriveReadiness } from '../../domain/readiness';
import type { ActivateProposalCommand, CreateProjectCommand, OperationIntent, ProjectDraft, PublishPlanCommand,
  PublishProjectLinkCommand, PublishProposalCommand, ReadOptions, RegisterPublisherCommand, RenewEntityCommand,
  ReplaceBookCommand, ReplaceProjectCommand, Repository, Result, ShareOfferCommand } from '../types';
import type { OperationController } from '../operations';
import { asResult, repositoryError } from './errors';
import { publicKey } from './envelope';
import { ArkivReader } from './reader';
import type { ArkivReaderOptions } from './reader';
import { ArkivWriter } from './writer';

export interface ArkivRepositoryOptions extends ArkivReaderOptions {
  controller?: OperationController;
  receiptTimeoutMs?: number;
}
export class ArkivRepository implements Repository {
  readonly mode = 'public' as const;
  readonly reader: ArkivReader;
  readonly writer: ArkivWriter;
  constructor(options: ArkivRepositoryOptions = {}) {
    this.reader = new ArkivReader(options);
    this.writer = new ArkivWriter(this.reader, options.controller, options.receiptTimeoutMs);
  }
  listProjects(actor: Actor, options?: ReadOptions) { return asResult(() => this.reader.listProjects(actor, options)); }
  loadProject(root: EntityKey, options?: ReadOptions) { return asResult(() => this.reader.loadProject(root, options)); }
  loadPublisher(root: EntityKey, options?: ReadOptions) { return asResult(() => this.reader.loadPublisher(root, options)); }
  listOwnPublishers(actor: Actor, options?: ReadOptions) { return asResult(() => this.reader.listOwnPublishers(actor, options)); }
  listIncomingOffers(root: EntityKey, options?: ReadOptions) { return asResult(() => this.reader.links('offer', root, options)); }
  listRequests(root: EntityKey, options?: ReadOptions) { return asResult(() => this.reader.links('request', root, options)); }
  prepareProjectDraft(recipe: CreateProjectCommand['recipe']): Result<ProjectDraft> {
    try {
      const validation = validateRecipe(recipe);
      if (!validation.valid) return { ok: false, error: { code: 'invalid_input', reasons: validation.reasons, retryable: false } };
      if (recipe.sourceProjectRoot) publicKey(recipe.sourceProjectRoot);
      const now = this.reader.now();
      return { ok: true, value: { id: globalThis.crypto.randomUUID(), recipe: structuredClone(recipe), createdAt: now, updatedAt: now } };
    } catch (error) { return { ok: false, error: repositoryError(error) }; }
  }
  createProject(command: CreateProjectCommand) { return asResult(() => this.writer.createProject(command)); }
  registerPublisher(command: RegisterPublisherCommand) { return asResult(() => this.writer.registerPublisher(command)); }
  replaceProject(command: ReplaceProjectCommand) { return asResult(() => this.writer.replaceProject(command)); }
  replaceBook(command: ReplaceBookCommand) { return asResult(() => this.writer.replaceBook(command)); }
  publishProposal(command: PublishProposalCommand) { return asResult(() => this.writer.publishProposal(command)); }
  activateProposal(command: ActivateProposalCommand) { return asResult(() => this.writer.activateProposal(command)); }
  publishProjectLink(command: PublishProjectLinkCommand) { return asResult(() => this.writer.publishProjectLink(command)); }
  publishPlan(command: PublishPlanCommand) { return asResult(() => this.writer.publishPlan(command)); }
  shareOffer(command: ShareOfferCommand) { return asResult(() => this.writer.shareOffer(command)); }
  renewEntity(command: RenewEntityCommand) { return asResult(() => this.writer.renewEntity(command)); }
  reconcile(operation: OperationIntent) { return asResult(() => this.writer.reconcile(operation)); }
  exportPacket(root: EntityKey, options?: ReadOptions) {
    return asResult(async () => {
      const project = await this.reader.loadProject(root, options);
      return { format: 'partfolk-export' as const, version: 1 as const, exportedAt: this.reader.now(), mode: this.mode,
        project, readiness: deriveReadiness(project, project.snapshot.blockTimestamp), snapshot: project.snapshot };
    });
  }
}
export function createArkivRepository(options: ArkivRepositoryOptions = {}): ArkivRepository {
  return new ArkivRepository(options);
}
