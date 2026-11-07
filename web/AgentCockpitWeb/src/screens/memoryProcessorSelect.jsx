import { processorProfileChoices } from './processorProfiles';

export default function MemoryProcessorSelect({ profiles, selectedId, metadataForProfile, onChange }){
  const choices = processorProfileChoices(profiles, metadataForProfile, 'restrictedText', selectedId);
  const unavailable = choices.find(choice => choice.profile.id === selectedId)?.disabled;
  return <>
    <select value={selectedId || ''} onChange={event => onChange(event.target.value)}>
      {choices.length === 0 ? <option value="">No eligible CLI profiles available</option> : null}
      {choices.map(({ profile, disabled }) => <option key={profile.id} value={profile.id} disabled={disabled}>{profile.name}{disabled ? ' (unavailable for Memory)' : ''}</option>)}
    </select>
    {unavailable ? <span className="settings-field-hint u-err">Memory requires a profile that can run without tools. Select another Memory profile.</span> : null}
  </>;
}
