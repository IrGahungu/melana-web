import React, { useState } from "react";
import { useRouter } from "expo-router";
import { ImageBackground, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import DropDownPicker from "react-native-dropdown-picker";
import { useLanguageStore, translations } from "@/stores/languageStore";

const backgroundImage = require("@/assets/images/two.jpg");

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { language, setLanguage } = useLanguageStore();
  const t = translations[language] ?? translations.en;
  const subtitle = t["Dieu avec Gahungu, Votre Santé est assurée"] ?? "God with Gahungu, Your Health is guaranteed.";
  const [langOpen, setLangOpen] = useState(false);
  const [langItems, setLangItems] = useState([
    { label: "English", value: "en" },
    { label: "Français", value: "fr" },
    { label: "Kirundi", value: "rn" },
  ]);

  return (
    <ImageBackground source={backgroundImage} style={styles.container} resizeMode="cover">
      <View style={styles.overlay} />

      <View style={[styles.langSelectorWrapper, { top: insets.top + 10 }]}>
        <DropDownPicker
          open={langOpen}
          value={language}
          items={langItems}
          setOpen={setLangOpen}
          setValue={(callback) => {
            const val = typeof callback === "function" ? callback(language) : callback;
            setLanguage(val as any);
          }}
          setItems={setLangItems}
          placeholder={t.language || "Language"}
          style={styles.langDropdown}
          dropDownContainerStyle={styles.langDropdownContainer}
          containerStyle={styles.langContainer}
          listMode="SCROLLVIEW"
        />
      </View>

      <View style={styles.content}>
        <Text style={styles.title}>Ikaze kuri MELANA</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>

      <Pressable style={styles.arrowButton} onPress={() => router.replace("/auth")}> 
        <Text style={styles.arrowText}>→</Text>
      </Pressable>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "flex-end",
    padding: 24,
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(15, 23, 42, 0.35)",
  },
  content: {
    position: "relative",
    zIndex: 1,
    maxWidth: 360,
    marginBottom: 90,
  },
  langSelectorWrapper: {
    position: "absolute",
    right: 24,
    zIndex: 2,
  },
  langContainer: {
    width: 140,
  },
  langDropdown: {
    borderColor: "#111827",
    borderWidth: 1.2,
    borderRadius: 999,
    minHeight: 42,
    backgroundColor: "rgba(255,255,255,0.78)",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  langDropdownContainer: {
    borderColor: "#111827",
    borderWidth: 1.2,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.92)",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#FFFFFF",
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: "#F8FAFC",
    lineHeight: 24,
  },
  arrowButton: {
    position: "absolute",
    right: 24,
    bottom: 28,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#E0F7FA",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    zIndex: 1,
  },
  arrowText: {
    color: "#0F172A",
    fontSize: 24,
    fontWeight: "700",
  },
});
