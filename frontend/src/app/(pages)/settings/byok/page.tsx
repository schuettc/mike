"use client";

import { useState } from "react";

import { ByokProviderModal } from "@/app/components/settings/ByokProviderModal";
import { ConnectorCard } from "@/app/components/settings/ConnectorCard";
import {
    BEDROCK_IAM_FIELD,
    MODEL_API_KEY_FIELDS,
    ModelProviderIcon,
    type ModelApiKeyField,
} from "@/app/components/settings/modelProviders";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { isMfaRequiredError, type ApiKeyProvider } from "@/app/lib/mikeApi";
/**
 * A provider is listed as saved once the user has saved their own key for it. It
 * stays there while switched off, so the switch does not move under the
 * pointer and the provider can be switched back on.
 *
 * Amazon Bedrock (IAM) has no key: it is listed only when the deployment's
 * AWS role is configured, counts as saved while it has Model Selections, and
 * switching it off removes them. Switched off on this visit, it stays under
 * Saved Providers until the page is left.
 */
const PROVIDER_SECTIONS = [
    {
        id: "active",
        active: true,
        title: "Saved Providers",
        empty: "No saved providers yet. Add an API key to one of the providers below.",
    },
    {
        id: "available",
        active: false,
        title: "Available Providers",
        empty: "Every provider has a key saved.",
    },
] as const;

export default function ByokPage() {
    const { profile, loading, updateApiKeyEnabled, updateRouterModels } =
        useUserProfile();
    const [busyProvider, setBusyProvider] = useState<ApiKeyProvider | null>(null);
    const [toggleError, setToggleError] = useState<string | null>(null);
    const [pendingToggle, setPendingToggle] = useState<{ provider: ApiKeyProvider; enabled: boolean } | null>(null);
    const [selectedProvider, setSelectedProvider] = useState<string | null>(
        null,
    );
    const [bedrockIamSwitchedOff, setBedrockIamSwitchedOff] = useState(false);
    const bedrockIamOn = (profile?.bedrockIamModels?.length ?? 0) > 0;
    const providerFields = profile?.apiKeys["bedrock-iam"]?.configured
        ? MODEL_API_KEY_FIELDS.flatMap((field) =>
              field.provider === "bedrock" ? [field, BEDROCK_IAM_FIELD] : [field],
          )
        : MODEL_API_KEY_FIELDS;
    const isSaved = (field: ModelApiKeyField) =>
        field.provider === "bedrock-iam"
            ? bedrockIamOn || bedrockIamSwitchedOff
            : profile?.apiKeys[field.provider]?.source === "user";
    const selected = providerFields.find(
        (field) => field.provider === selectedProvider,
    );

    async function toggleProvider(provider: ApiKeyProvider, enabled: boolean) {
        setBusyProvider(provider);
        setToggleError(null);
        try {
            const saved = await updateApiKeyEnabled(provider, enabled);
            if (!saved) setToggleError("The provider could not be updated. Please try again.");
        } catch (error) {
            if (isMfaRequiredError(error)) setPendingToggle({ provider, enabled });
            else setToggleError("The provider could not be updated. Please try again.");
        } finally {
            setBusyProvider(null);
        }
    }

    async function toggleBedrockIam(enabled: boolean) {
        if (enabled) {
            setSelectedProvider("bedrock-iam");
            return;
        }
        setBedrockIamSwitchedOff(true);
        setBusyProvider("bedrock-iam");
        setToggleError(null);
        try {
            const saved = await updateRouterModels("bedrock-iam", []);
            if (!saved) setToggleError("The provider could not be updated. Please try again.");
        } finally {
            setBusyProvider(null);
        }
    }

    const renderToggle = (field: ModelApiKeyField, label: string) => (
        <ToggleSwitchUI
            checked={
                field.provider === "bedrock-iam"
                    ? bedrockIamOn
                    : profile?.apiKeys[field.provider]?.enabled !== false
            }
            disabled={busyProvider !== null || pendingToggle !== null}
            aria-busy={busyProvider === field.provider}
            aria-label={label}
            onCheckedChange={(enabled) =>
                void (field.provider === "bedrock-iam"
                    ? toggleBedrockIam(enabled)
                    : toggleProvider(field.provider, enabled))
            }
        />
    );

    const renderCard = (field: ModelApiKeyField) => {
        const hasSavedKey = isSaved(field);
        const blocked = loading || busyProvider === field.provider;
        const open = () => {
            if (!blocked) setSelectedProvider(field.provider);
        };
        return (
            <ConnectorCard
                key={field.provider}
                kind="provider"
                name={field.name}
                icon={<ModelProviderIcon field={field} loading={loading} />}
                // Like connectors: a saved provider opens from anywhere on
                // its card, an available one only from its Add button.
                onOpen={hasSavedKey ? open : undefined}
                action={
                    hasSavedKey ? (
                        renderToggle(field, `${field.name} provider`)
                    ) : (
                        <PillButtonUI
                            tone="blue"
                            size="sm"
                            disabled={blocked}
                            aria-label={`Add ${field.name}`}
                            aria-haspopup="dialog"
                            onClick={open}
                        >
                            Add
                        </PillButtonUI>
                    )
                }
            />
        );
    };

    return (
        <div className="@container space-y-8">
            {PROVIDER_SECTIONS.map((section) => {
                // While the profile loads, which providers are active is not
                // known yet: every card waits in the second section.
                const fields = providerFields.filter(
                    (field) => (!loading && isSaved(field)) === section.active,
                );
                const headingId = `byok-${section.id}-providers`;
                return (
                    <section
                        key={section.id}
                        aria-labelledby={headingId}
                        className="space-y-3"
                    >
                        <SettingsHeading id={headingId}>
                            {section.title}
                        </SettingsHeading>
                        {loading && section.active ? (
                            <span className="block h-5 w-56 max-w-full animate-pulse rounded bg-gray-200" />
                        ) : fields.length === 0 ? (
                            <SettingsDescription>
                                {section.empty}
                            </SettingsDescription>
                        ) : (
                            <div
                                className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2"
                                aria-busy={loading}
                            >
                                {fields.map(renderCard)}
                            </div>
                        )}
                    </section>
                );
            })}
            <ByokProviderModal
                provider={selected ?? null}
                enabledToggle={
                    selected &&
                    selected.provider !== "bedrock-iam" &&
                    profile?.apiKeys[selected.provider]?.source === "user"
                        ? renderToggle(selected, `Use ${selected.name}`)
                        : undefined
                }
                onClose={() => setSelectedProvider(null)}
            />
            <MfaVerificationPopup
                open={pendingToggle !== null}
                onCancel={() => setPendingToggle(null)}
                onVerified={() => {
                    if (!pendingToggle) return;
                    const action = pendingToggle;
                    setPendingToggle(null);
                    void toggleProvider(action.provider, action.enabled);
                }}
            />
            <WarningPopup
                open={toggleError !== null}
                title="Provider update failed"
                message={toggleError}
                onClose={() => setToggleError(null)}
            />
        </div>
    );
}
