import { processorProfileChoices } from './processorProfiles';

export default function MemoryProcessorSelect({ profiles, selectedId, metadataForProfile, onChange }){
  return <ProcessorProfileSelect profiles={profiles} selectedId={selectedId} metadataForProfile={metadataForProfile}
    onChange={onChange} role="restrictedText" label="Memory"/>;
}

export function ProcessorProfileSelect({ profiles, selectedId, metadataForProfile, onChange, role = 'toolEnabled', label = 'processor', sequential = false, emptyLabel }){
  const choices = processorProfileChoices(profiles, metadataForProfile, role, selectedId, { sequential });
  const selected = choices.find(choice => choice.profile.id === selectedId);
  const missing = !!selectedId && !selected;
  const unavailable = missing || selected?.disabled;
  return <>
    <select value={selectedId || ''} onChange={event => {
      const id = event.target.value;
      if ((!id && emptyLabel) || choices.some(choice => choice.profile.id === id && !choice.disabled)) onChange(id);
    }}>
      {emptyLabel ? <option value="">{emptyLabel}</option> : !selectedId ? <option value="">{choices.length ? 'Select a CLI profile' : 'No eligible CLI profiles available'}</option> : null}
      {missing ? <option value={selectedId} disabled>Unavailable profile: {selectedId}</option> : null}
      {choices.map(({ profile, disabled }) => <option key={profile.id} value={profile.id} disabled={disabled}>{profile.name}{disabled ? ` (unavailable for ${label})` : ''}</option>)}
    </select>
    {unavailable ? <span className="settings-field-hint u-err">{role === 'restrictedText'
      ? 'Memory requires a profile that can run without tools. Select another Memory profile.'
      : missing ? 'Saved CLI profile is missing. Select another profile.'
        : selected.reason.replace('toolEnabled', 'tool-enabled background work')}</span> : null}
  </>;
}
