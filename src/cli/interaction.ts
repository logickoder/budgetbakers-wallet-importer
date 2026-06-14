import readline from "readline";

import { isValidEmail, listSavedEmails, normalizeEmail } from "../storage/index.js";
import type { SessionIndex } from "../types.js";

export function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function normalizeAndValidate(value: string): string | null {
    const normalized = normalizeEmail(value);
    return isValidEmail(normalized) ? normalized : null;
}

export async function askRequiredEmail(prompt: string): Promise<string> {
    while (true) {
        const raw = await ask(prompt);
        if (!raw.trim()) {
            console.error("Email is required.");
            continue;
        }
        const valid = normalizeAndValidate(raw);
        if (valid) return valid;
        console.error(`"${raw}" is not a valid email address.`);
    }
}

export async function selectEmail(index: SessionIndex, explicitEmail: string | null): Promise<string> {
    if (explicitEmail) {
        const valid = normalizeAndValidate(explicitEmail);
        if (!valid) {
            throw new Error(`--email "${explicitEmail}" is not a valid email address.`);
        }
        return valid;
    }

    const savedEmails = listSavedEmails(index);

    if (savedEmails.length === 0) {
        return askRequiredEmail("Email address: ");
    }

    if (savedEmails.length === 1) {
        const onlyEmail = savedEmails[0];
        console.log(`Found saved session for ${onlyEmail}.`);
        while (true) {
            const answer = await ask(
                `Press Enter to continue with ${onlyEmail}, or type a different email: `
            );
            if (!answer.trim()) return onlyEmail;
            const valid = normalizeAndValidate(answer);
            if (valid) return valid;
            console.error(`"${answer}" is not a valid email address. Press Enter to keep ${onlyEmail}.`);
        }
    }

    console.log("Saved sessions:");
    for (let i = 0; i < savedEmails.length; i++) {
        const email = savedEmails[i];
        const lastUsed = index.lastUsedEmail === email ? " (last used)" : "";
        console.log(`  [${i + 1}] ${email}${lastUsed}`);
    }

    while (true) {
        const answer = await ask(`Choose 1-${savedEmails.length} or type a new email: `);
        const trimmed = answer.trim();

        if (!trimmed && index.lastUsedEmail && savedEmails.includes(index.lastUsedEmail)) {
            return index.lastUsedEmail;
        }

        const selected = Number.parseInt(trimmed, 10);
        if (!Number.isNaN(selected) && selected >= 1 && selected <= savedEmails.length) {
            return savedEmails[selected - 1];
        }

        const valid = normalizeAndValidate(trimmed);
        if (valid) return valid;
        console.error("Please choose a valid number or provide a valid email address.");
    }
}
