import { useId, useMemo } from 'react';
import type { ProjectMetadata } from '../persistence';
import { ProjectThumbnail } from './ProjectThumbnail';

interface ProjectGalleryProps {
  projects: readonly ProjectMetadata[];
  disabled?: boolean;
  onOpen: (project: ProjectMetadata) => void;
  onDelete: (project: ProjectMetadata) => void;
  deleteConfirmId?: string | null;
  onCreate: (button: HTMLButtonElement) => void;
  onImport: () => void;
}

function editedDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

interface ProjectCardProps {
  project: ProjectMetadata;
  disabled: boolean;
  confirming: boolean;
  onOpen: (project: ProjectMetadata) => void;
  onDelete: (project: ProjectMetadata) => void;
}

function ProjectCard({ project, disabled, confirming, onOpen, onDelete }: ProjectCardProps) {
  const metadataDescriptionId = useId();
  const size = typeof project.width === 'number' && typeof project.height === 'number'
    && Number.isInteger(project.width) && Number.isInteger(project.height)
    && project.width > 0 && project.height > 0
    ? `${project.width} × ${project.height} stitches`
    : 'Size unavailable';

  return (
    <article className="project-gallery-card">
      <button
        className="project-gallery-open"
        type="button"
        disabled={disabled}
        onClick={() => onOpen(project)}
        aria-label={`Open ${project.title}`}
        aria-describedby={metadataDescriptionId}
      >
        <ProjectThumbnail revision={project.revision} width={project.width} height={project.height} thumbnail={project.thumbnail} />
        <span className="project-gallery-copy">
          <span id={metadataDescriptionId} className="project-gallery-meta">
            {size} | Edited {editedDate(project.updatedAt)}
          </span>
          <span className="project-gallery-name">{project.title}</span>
        </span>
      </button>
      <div className="project-gallery-card-actions">
        <button
          className={`project-gallery-delete${confirming ? ' project-gallery-delete-confirming' : ''}`}
          type="button"
          disabled={disabled}
          aria-label={confirming ? `Confirm delete ${project.title}` : `Delete ${project.title}`}
          onClick={() => onDelete(project)}
        >
          {confirming ? 'Confirm delete?' : 'Delete'}
        </button>
        <button
          className="project-gallery-footer-open"
          type="button"
          disabled={disabled}
          onClick={() => onOpen(project)}
          aria-label={`Open pattern: ${project.title}`}
          aria-describedby={metadataDescriptionId}
        >
          <span aria-hidden="true">Open →</span>
        </button>
      </div>
    </article>
  );
}

export function ProjectGallery({
  projects,
  disabled = false,
  onOpen,
  onDelete,
  deleteConfirmId = null,
  onCreate,
  onImport
}: ProjectGalleryProps) {
  const sortedProjects = useMemo(() => [...projects].sort((left, right) =>
    right.updatedAt - left.updatedAt
    || right.revision - left.revision
    || left.id.localeCompare(right.id)
  ), [projects]);

  return (
    <section className="project-gallery" aria-labelledby="projects-title">
      <header className="project-gallery-header">
        <div>
          <h1 id="projects-title">Projects</h1>
        </div>
        <div className="project-gallery-actions">
          <button className="button button-secondary" type="button" disabled={disabled} onClick={onImport}>
            Import project
          </button>
          <button className="button button-primary" type="button" disabled={disabled} onClick={(event) => onCreate(event.currentTarget)}>
            <span aria-hidden="true">＋</span> New pattern
          </button>
        </div>
      </header>

      {sortedProjects.length === 0 ? (
        <div className="project-gallery-empty" role="status">
          <div className="project-gallery-empty-icon" aria-hidden="true">＋</div>
          <div>
            <h2>Your canvas is ready</h2>
            <p>Create a pattern from scratch or bring in a local project to get started.</p>
            <div className="actions">
              <button className="button button-primary" type="button" disabled={disabled} onClick={(event) => onCreate(event.currentTarget)}>Create your first pattern <span aria-hidden="true">→</span></button>
              <button className="button button-secondary" type="button" disabled={disabled} onClick={onImport}>Import a project</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="project-gallery-grid">
          {sortedProjects.map((project) => {
            return <ProjectCard key={project.id} project={project} disabled={disabled} confirming={deleteConfirmId === project.id} onOpen={onOpen} onDelete={onDelete} />;
          })}
        </div>
      )}
    </section>
  );
}
