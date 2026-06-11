import { useEffect, useMemo, useState, type RefObject } from 'react';
import {
  backendIdForProfile,
  goalCapabilityForBackend,
  isClaudeBackend,
  reconcileEffort,
} from './appModel';
import type { AgentCockpitAPI } from './api';
import type {
  BackendMetadata,
  ClaudeCodeMode,
  Conversation,
  EffortLevel,
  ServiceTier,
  Settings,
} from './types';

type UseRunSelectionOptions = {
  activeConversation: Conversation | null;
  backends: BackendMetadata[];
  clientRef: RefObject<AgentCockpitAPI>;
  settings: Settings | null;
  onError: (error: unknown) => void;
};

export function useRunSelection(options: UseRunSelectionOptions) {
  const [profileMetadata, setProfileMetadata] = useState<Record<string, BackendMetadata>>({});
  const [selectedCliProfileId, setSelectedCliProfileId] = useState<string | undefined>();
  const [selectedBackend, setSelectedBackend] = useState<string | undefined>();
  const [selectedModel, setSelectedModel] = useState<string | undefined>();
  const [selectedEffort, setSelectedEffort] = useState<EffortLevel | undefined>();
  const [selectedClaudeCodeMode, setSelectedClaudeCodeMode] = useState<ClaudeCodeMode | 'default' | undefined>();
  const [selectedServiceTier, setSelectedServiceTier] = useState<ServiceTier | 'default' | undefined>();

  const availableProfiles = useMemo(() => (options.settings?.cliProfiles || []).filter((profile) => profile.disabled !== true), [options.settings]);
  const selectedProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === selectedCliProfileId),
    [availableProfiles, selectedCliProfileId],
  );
  const profileSelectionLocked = (options.activeConversation?.messages.length || 0) > 0;
  const selectedProfileBackendID = selectedProfile ? backendIdForProfile(selectedProfile) : undefined;
  const selectedBackendMetadata = useMemo(() => {
    if (selectedProfile) {
      const profileBackendID = profileSelectionLocked ? selectedBackend : selectedProfileBackendID;
      const providerMetadata = options.backends.find((backend) => backend.id === profileBackendID);
      const selectedProfileMetadata = profileMetadata[selectedCliProfileId || ''];
      if (providerMetadata && selectedProfileMetadata && providerMetadata.id !== selectedProfileMetadata.id) {
        return {
          ...providerMetadata,
          models: selectedProfileMetadata.models || providerMetadata.models,
        };
      }
      return selectedProfileMetadata || providerMetadata;
    }
    if (selectedCliProfileId && profileMetadata[selectedCliProfileId]) {
      return profileMetadata[selectedCliProfileId];
    }
    return options.backends.find((backend) => backend.id === selectedBackend);
  }, [options.backends, profileMetadata, profileSelectionLocked, selectedBackend, selectedCliProfileId, selectedProfile, selectedProfileBackendID]);
  const selectedModelMetadata = useMemo(
    () => selectedBackendMetadata?.models?.find((model) => model.id === selectedModel),
    [selectedBackendMetadata, selectedModel],
  );
  const supportedEfforts = useMemo(() => selectedModelMetadata?.supportedEffortLevels || [], [selectedModelMetadata]);
  const selectedBackendID = selectedProfile
    ? (profileSelectionLocked ? selectedBackend : selectedProfileBackendID)
    : selectedBackendMetadata?.id || selectedBackend;
  const selectedGoalCapability = useMemo(
    () => goalCapabilityForBackend(options.backends, selectedBackendID, selectedBackendMetadata),
    [options.backends, selectedBackendID, selectedBackendMetadata],
  );
  const goalCapable = selectedGoalCapability.set === true;
  const serviceTierEnabled = selectedBackendID === 'codex';
  const claudeCodeModeEnabled = isClaudeBackend(selectedBackendID) && supportedEfforts.includes('xhigh');
  const claudeCodeModeForRequest: ClaudeCodeMode | null | undefined = claudeCodeModeEnabled
    ? selectedClaudeCodeMode === 'ultracode'
      ? 'ultracode'
      : selectedClaudeCodeMode === 'default'
        ? null
        : undefined
    : undefined;
  const claudeCodeModeForSelection: ClaudeCodeMode | null | undefined = claudeCodeModeEnabled
    ? selectedClaudeCodeMode === 'ultracode'
      ? 'ultracode'
      : selectedClaudeCodeMode === 'default'
        ? null
        : undefined
    : undefined;

  useEffect(() => {
    if (!profileSelectionLocked && selectedProfileBackendID && selectedBackend !== selectedProfileBackendID) {
      setSelectedBackend(selectedProfileBackendID);
    }
  }, [profileSelectionLocked, selectedBackend, selectedProfileBackendID]);

  useEffect(() => {
    if (!claudeCodeModeEnabled && selectedClaudeCodeMode) {
      setSelectedClaudeCodeMode(undefined);
    }
  }, [claudeCodeModeEnabled, selectedClaudeCodeMode]);

  useEffect(() => {
    if (selectedCliProfileId) {
      void loadProfileMetadata(selectedCliProfileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Profile metadata loads are keyed only by selected profile id; the loader reads current settings refs internally.
  }, [selectedCliProfileId]);

  useEffect(() => {
    setSelectedEffort((current) => reconcileEffort(current, supportedEfforts));
  }, [supportedEfforts]);

  function hydrateSelectionDefaults(loadedSettings: Settings) {
    const profiles = (loadedSettings.cliProfiles || []).filter((profile) => profile.disabled !== true);
    const profileID = loadedSettings.defaultCliProfileId;
    const profile = profiles.find((item) => item.id === profileID);
    const backendID = loadedSettings.defaultBackend;
    setSelectedCliProfileId(profileID);
    setSelectedBackend(backendIdForProfile(profile) || backendID);
    setSelectedModel(loadedSettings.defaultModel);
    setSelectedEffort(loadedSettings.defaultEffort);
    setSelectedClaudeCodeMode(undefined);
    setSelectedServiceTier(loadedSettings.defaultBackend === 'codex' ? loadedSettings.defaultServiceTier : undefined);
    if (profileID) {
      void loadProfileMetadata(profileID);
    }
  }

  function hydrateSelectionFromConversation(conversation: Conversation) {
    setSelectedCliProfileId(conversation.cliProfileId || options.settings?.defaultCliProfileId);
    setSelectedBackend(conversation.backend || options.settings?.defaultBackend);
    setSelectedModel(conversation.model || options.settings?.defaultModel);
    setSelectedEffort(conversation.effort || options.settings?.defaultEffort);
    setSelectedClaudeCodeMode(conversation.claudeCodeMode || undefined);
    setSelectedServiceTier(conversation.backend === 'codex' ? (conversation.serviceTier || 'default') : undefined);
  }

  async function loadProfileMetadata(profileID: string) {
    if (profileMetadata[profileID]) {
      return;
    }
    try {
      const metadata = await options.clientRef.current.getCliProfileMetadata(profileID);
      setProfileMetadata((current) => ({ ...current, [profileID]: metadata }));
    } catch (error) {
      options.onError(error);
    }
  }

  function chooseProfile(profileID: string) {
    if (profileSelectionLocked) {
      return;
    }
    const profile = availableProfiles.find((item) => item.id === profileID);
    setSelectedCliProfileId(profileID);
    setSelectedBackend(backendIdForProfile(profile));
    setSelectedModel(undefined);
    setSelectedEffort(undefined);
    setSelectedClaudeCodeMode(undefined);
    setSelectedServiceTier(profile?.harness === 'codex' ? (selectedServiceTier || options.settings?.defaultServiceTier) : undefined);
  }

  return {
    availableProfiles,
    selectedProfile,
    profileSelectionLocked,
    profileMetadata,
    selectedCliProfileId,
    selectedBackend,
    selectedModel,
    selectedEffort,
    selectedClaudeCodeMode,
    selectedServiceTier,
    selectedBackendMetadata,
    selectedModelMetadata,
    supportedEfforts,
    selectedBackendID,
    selectedGoalCapability,
    goalCapable,
    serviceTierEnabled,
    claudeCodeModeEnabled,
    claudeCodeModeForRequest,
    claudeCodeModeForSelection,
    setSelectedModel,
    setSelectedEffort,
    setSelectedClaudeCodeMode,
    setSelectedServiceTier,
    hydrateSelectionDefaults,
    hydrateSelectionFromConversation,
    chooseProfile,
  };
}
