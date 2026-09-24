import { describe, expect, it } from "vite-plus/test";
import {
    decryptMonitoringPassword,
    encryptMonitoringPassword,
} from "../../packages/workflows/src/secrets";

describe("monitoring credentials", () => {
    const key = "a-secure-test-encryption-key-32-characters";
    it("encrypts credentials with randomized authenticated encryption scoped to the cluster", () => {
        const encrypted = encryptMonitoringPassword("password", key, "cluster-a");
        expect(encrypted).not.toContain("password");
        expect(encrypted).not.toBe(encryptMonitoringPassword("password", key, "cluster-a"));
        expect(decryptMonitoringPassword(encrypted, key, "cluster-a")).toBe("password");
        expect(() => decryptMonitoringPassword(encrypted, key, "cluster-b")).toThrow();
        expect(() => decryptMonitoringPassword(encrypted, `${key}x`, "cluster-a")).toThrow();
        expect(() =>
            decryptMonitoringPassword(`${encrypted.slice(0, -2)}xx`, key, "cluster-a"),
        ).toThrow();
    });
});
