import { useEffect, useId, useState } from "react"
import { packageManagers, type PackageManager } from "../lib/links"
import { CommandChip } from "./CopyButton"
import "./install-picker.css"

const storageKey = "fluxerly.pm.v1"

function isPackageManager(value: unknown): value is PackageManager {
    return packageManagers.some((item) => item.id === value)
}

export default function InstallPicker() {
    const [choice, setChoice] = useState<PackageManager>("npm")
    const groupName = useId()

    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(storageKey)
            if (isPackageManager(stored)) setChoice(stored)
        } catch {
            // Storage is blocked, npm stays selected
        }
        // The slab on the hero's water shares the same choice
        const onChange = (event: Event) => {
            const next = (event as CustomEvent).detail
            if (isPackageManager(next)) setChoice(next)
        }
        window.addEventListener("fluxerly:pm", onChange)
        return () => window.removeEventListener("fluxerly:pm", onChange)
    }, [])

    const choose = (value: PackageManager) => {
        setChoice(value)
        try {
            window.localStorage.setItem(storageKey, value)
        } catch {
            // Storage is blocked, the choice lasts for this page
        }
        window.dispatchEvent(new CustomEvent("fluxerly:pm", { detail: value }))
    }

    const current = packageManagers.find((item) => item.id === choice) ?? packageManagers[0]

    return (
        <div className="pm">
            <fieldset className="pm-switch">
                <legend className="sr-only">Package manager</legend>
                {packageManagers.map((item) => (
                    <label key={item.id} className="pm-option">
                        <input
                            type="radio"
                            name={groupName}
                            value={item.id}
                            checked={choice === item.id}
                            onChange={() => choose(item.id)}
                        />
                        {item.label}
                    </label>
                ))}
            </fieldset>
            <CommandChip className="pm-chip" command={current.install} />
            <p className="pm-note">Adds the SDK to an existing project</p>
            <CommandChip className="pm-chip" command={current.init} />
            <p className="pm-note">Or start from a generated project with its first test</p>
        </div>
    )
}
