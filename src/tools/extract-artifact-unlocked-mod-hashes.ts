import { getDef, loadLocal, setApiKey } from '@d2api/manifest-node';
import {
  DestinyComponentType,
  DestinyProfileResponse,
  getProfile,
  HttpClient,
  searchDestinyPlayerByBungieName,
} from 'bungie-api-ts/destiny2';
import { UserInfoCard } from 'bungie-api-ts/user/interfaces.js';
import * as readline from 'readline';
import { annotate, writeFile } from '../helpers.js';
import { createHttpClient } from './http-client.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (query: string) =>
  new Promise((resolve: (answer: string) => void) => rl.question(query, resolve));

const setDifference = <T>(a: Set<T>, b: Set<T>): T[] => [...a].filter((entry) => !b.has(entry));

interface RelevantInfo {
  unlockedPlugSetItems: Set<number>;
  unlockedArtifactItems: Set<number>;
}

const extractProfileInfo = (
  response: DestinyProfileResponse,
  characterId: string
): RelevantInfo => {
  const unlockedPlugSetItems = new Set(
    Object.values(response.characterPlugSets.data![characterId].plugs).flatMap((plugSet) =>
      plugSet.filter((entry) => entry.enabled).map((entry) => entry.plugItemHash)
    )
  );
  const unlockedArtifactItems = new Set(
    response.characterProgressions.data![characterId].seasonalArtifact.tiers.flatMap((tier) =>
      tier.items.filter((item) => item.isActive).map((item) => item.itemHash)
    )
  );

  return { unlockedPlugSetItems, unlockedArtifactItems };
};

class ProfileStore {
  account: UserInfoCard;
  characterId: string;
  httpClient: HttpClient;

  lastProfile?: DestinyProfileResponse;
  lastInfo?: RelevantInfo;

  currentProfile?: DestinyProfileResponse;
  currentInfo?: RelevantInfo;

  constructor(characterId: string, httpClient: HttpClient, account: UserInfoCard) {
    this.characterId = characterId;
    this.httpClient = httpClient;
    this.account = account;
  }

  async getNewProfile(): Promise<boolean> {
    const newProfile = (
      await getProfile(this.httpClient, {
        membershipType: this.account.membershipType,
        destinyMembershipId: this.account.membershipId,
        components: [
          DestinyComponentType.Characters,
          DestinyComponentType.CharacterProgressions,
          DestinyComponentType.ItemSockets,
        ],
      })
    ).Response;
    if (
      !this.currentProfile ||
      new Date(this.currentProfile.responseMintedTimestamp) <
        new Date(newProfile.responseMintedTimestamp)
    ) {
      const newInfo = extractProfileInfo(newProfile, this.characterId);
      if (
        !this.currentInfo ||
        newInfo.unlockedArtifactItems.size === this.currentInfo.unlockedArtifactItems.size + 1
      ) {
        this.lastProfile = this.currentProfile;
        this.lastInfo = this.currentInfo;
        this.currentProfile = newProfile;
        this.currentInfo = newInfo;
        return true;
      } else if (
        newInfo.unlockedArtifactItems.size !== this.currentInfo.unlockedArtifactItems.size
      ) {
        throw new Error('fatal error: did not unlock exactly one artifact mod');
      }
    }
    return false;
  }
}

(async () => {
  try {
    const API_KEY = await prompt('Enter API Key: ');

    setApiKey(API_KEY);
    loadLocal();

    const httpClient = createHttpClient(fetch, API_KEY);

    let players = undefined;
    do {
      try {
        const [playerName, discriminator] = (await prompt('Enter BungieName#0000: ')).split('#');
        players = await searchDestinyPlayerByBungieName(
          httpClient,
          { membershipType: -1 },
          { displayName: playerName, displayNameCode: parseInt(discriminator, 10) }
        );
      } catch (e: any) {
        console.log(e.message);
      }
    } while (!players || !players.Response.length);

    const account = players.Response[0];
    const profile = await getProfile(httpClient, {
      membershipType: account.membershipType,
      destinyMembershipId: account.membershipId,
      components: [
        DestinyComponentType.Characters,
        DestinyComponentType.CharacterProgressions,
        DestinyComponentType.ItemSockets,
      ],
    });
    const characters = Object.entries(profile.Response.characters.data!);
    characters.forEach(([, data], index) => {
      console.log(`${index + 1}) ${getDef('Class', data.classHash)?.displayProperties.name}`);
    });
    let index = NaN;
    do {
      index = parseInt(await prompt('Which character: '), 10);
    } while (isNaN(index) || index < 1 || index > characters.length);
    const characterId = characters[index - 1][0];

    let initialInfo = extractProfileInfo(profile.Response, characterId);
    while (initialInfo.unlockedArtifactItems.size !== 3) {
      await prompt(
        'Please reset your artifact, then unlock exactly 3 first-column mods, then press enter (may take a while for fresh info)'
      );
      const profile = await getProfile(httpClient, {
        membershipType: account.membershipType,
        destinyMembershipId: account.membershipId,
        components: [
          DestinyComponentType.Characters,
          DestinyComponentType.CharacterProgressions,
          DestinyComponentType.ItemSockets,
        ],
      });
      initialInfo = extractProfileInfo(profile.Response, characterId);
    }

    const store = new ProfileStore(characterId, httpClient, account);
    store.getNewProfile();

    const unlockedModsPerArtifactUnlock: { [artifactModHash: number]: number[] } = {};
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await prompt('enter q to finish, or n to unlock an additional artifact mod: ');
      if (result === 'q') {
        break;
      } else if (result === 'n') {
        while (!(await store.getNewProfile())) {
          await prompt('did not get a new profile, wait a bit, then press enter:');
        }
        const [newArtifactMod] = setDifference(
          store.currentInfo!.unlockedArtifactItems,
          store.lastInfo!.unlockedArtifactItems
        );
        const newPlugSetItems = setDifference(
          store.currentInfo!.unlockedPlugSetItems,
          store.lastInfo!.unlockedPlugSetItems
        );

        console.log(newArtifactMod, '->', JSON.stringify(newPlugSetItems));
        unlockedModsPerArtifactUnlock[newArtifactMod] = newPlugSetItems;
      }
    }

    const pretty = JSON.stringify(unlockedModsPerArtifactUnlock, undefined, 2);
    const annotated = annotate(pretty);
    const outString = `export const artifactPlugUnlocks: { [artifactModHash: number]: number[] } = ${annotated};`;
    writeFile('./data/artifact-mod-unlocks.ts', outString);
  } catch (e: any) {
    console.error('Error', e.message);
  }
})();
