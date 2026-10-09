import type { ProjectAggregate } from '../../domain/types';
import { Notice } from '../../ui';
import { projectNeedsModel } from './projectNeedsModel';
import './projectNeeds.css';

/** Shared read-only recipe presentation for Studio and Partner Desk. */
export function ProjectNeeds({ project }: { project: ProjectAggregate }) {
  const model = projectNeedsModel(project);
  if (!model.available) return <Notice tone={model.notice.tone} title={model.notice.title}>{model.notice.message}</Notice>;
  return <section className="pf-stack project-needs" aria-label={model.heading}>
    <header className="pf-stack pf-stack--compact"><h2>{model.heading}</h2><p><strong>{model.title}</strong></p><p>{model.outcome}</p><p>Project time zone: {model.timeZone}. Each option below gives its own time zone and exact required intervals.</p></header>
    {model.snapshotNotice && <Notice tone="warning">{model.snapshotNotice}</Notice>}
    {model.notice.tone === 'warning' ? <Notice tone="warning" title={model.notice.title}>{model.notice.message}</Notice> : <p>{model.notice.message}</p>}
    {model.instructions && <div className="pf-stack pf-stack--compact"><h3>Instructions for everyone</h3><p className="project-needs-instructions">{model.instructions}</p></div>}
    {model.variants.map(variant => <section className="pf-sheet pf-stack" key={variant.id} aria-label={variant.title}>
      <header className="pf-stack pf-stack--compact"><h3>{variant.title}</h3><p><strong>Place:</strong> {variant.venueId}</p><p><strong>Time zone:</strong> {variant.timeZone}</p></header>
      {variant.instructions && <p className="project-needs-instructions"><strong>Option instructions:</strong> {variant.instructions}</p>}
      {variant.requirements.map(requirement => <section className="project-needs-requirement pf-stack pf-stack--compact" key={requirement.id}>
        <h4>{requirement.title}</h4>
        <dl className="project-needs-facts">
          <dt>Quantity needed</dt><dd>{requirement.quantityLabel}</dd>
          <dt>Kind</dt><dd>{requirement.kindLabel}</dd>
          <dt>Required from</dt><dd><time dateTime={requirement.startIso}>{requirement.startLabel}</time></dd>
          <dt>Required until</dt><dd><time dateTime={requirement.endIso}>{requirement.endLabel}</time></dd>
          <dt>Must follow</dt><dd>{requirement.dependencies.length ? requirement.dependencies.map(dependency => dependency.label).join(', ') : 'No preceding requirement'}</dd>
        </dl>
        {requirement.instructions && <p className="project-needs-instructions"><strong>Requirement instructions:</strong> {requirement.instructions}</p>}
      </section>)}
      <details><summary>Exact matching details for an offer</summary><p>Option reference: <code>{variant.id}</code></p><ul>{variant.requirements.map(requirement => <li key={requirement.id}><strong>{requirement.title}</strong><p>Required capability: <code>{requirement.capability}</code></p><p>Requirement reference: <code>{requirement.id}</code></p></li>)}</ul></details>
    </section>)}
    {model.sourceProjectRoot && <details><summary>Where these needs came from</summary><p>Adapted from project <code>{model.sourceProjectRoot}</code>. This reference carries no participants or approvals into this project.</p></details>}
  </section>;
}
