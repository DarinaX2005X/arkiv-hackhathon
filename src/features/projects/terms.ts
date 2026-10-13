import type { Condition, ProjectAggregate } from '../../domain/types';
import { publisherName } from './selectors';

/** Human names are labels only; unknown references stay visible for review. */
export function conditionText(condition: Condition, project: ProjectAggregate): string {
  if (condition.kind === 'requires_offer' || condition.kind === 'excludes_offer') {
    const publisher = project.publishers.find(item => item.root.key === condition.offer.publisherRoot);
    const offer = publisher?.book.status === 'unique' ? publisher.book.entity.payload.offers.find(item => item.id === condition.offer.offerId)?.title : null;
    return `${condition.kind === 'requires_offer' ? 'Requires' : 'Cannot combine with'} ${offer ?? condition.offer.offerId} from ${publisherName(project, condition.offer.publisherRoot)}.`;
  }
  if (condition.kind === 'requires_capability') return `Requires someone to provide: ${condition.capability}.`;
  if (condition.kind === 'allowed_variants') {
    const variants = project.state.status === 'unique' ? project.state.entity.payload.recipe.variants : [];
    return `Available for these options: ${condition.variantIds.map(id => variants.find(variant => variant.id === id)?.title ?? id).join(', ')}.`;
  }
  return `Available at these places: ${condition.venueIds.join(', ')}.`;
}

export function resourceName(project: ProjectAggregate, publisherRoot: string, resourceId: string): string {
  const publisher = project.publishers.find(item => item.root.key === publisherRoot);
  return publisher?.book.status === 'unique' ? publisher.book.entity.payload.resources.find(item => item.id === resourceId)?.name ?? resourceId : resourceId;
}
