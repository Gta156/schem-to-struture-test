import { readFile } from 'fs/promises';
import { join } from 'path';

const JAVA_MAP_DIR = './java to_universal/minecraft/vanilla'; // Relative path
const BEDROCK_MAP_DIR = './from_universal to bedrock/universal_minecraft/vanilla'; // Relative path

const jsonCache = new Map();

/**
 * Loads and caches JSON mapping files.
 */
async function loadJsonMap(filePath) {
    if (jsonCache.has(filePath)) {
        return jsonCache.get(filePath);
    }
    try {
        // Using relative path from server location
        const absolutePath = join(process.cwd(), filePath);
        // console.log(`Attempting to load map: ${absolutePath}`); // Debug log
        const content = await readFile(absolutePath, 'utf-8');
        const data = JSON.parse(content);
        jsonCache.set(filePath, data);
        return data;
    } catch (error) {
        if (error.code === 'ENOENT') {
             console.warn(`Warning: Mapping file not found: ${filePath} (resolved to: ${join(process.cwd(), filePath)})`);
        } else {
            console.error(`Error reading or parsing JSON file ${filePath}:`, error);
        }
        jsonCache.set(filePath, null); // Cache null if error
        return null;
    }
}

/**
 * Parses a Minecraft Java Edition command string.
 */
function parseJavaCommand(line) {
    line = line.trim();
    if (!line || line.startsWith('#')) {
        return null;
    }

    // Regex updated to better handle spaces in coordinates and potential missing state/NBT parts
    const match = line.match(/^(setblock|fill)\s+((?:~?-?\d*\s*){3})\s*(?:((?:~?-?\d*\s*){3})\s+)?([\w:]+)(?:\[([^\]]*)\])?(?:\s+(\{.*\})?)?$/);

    if (!match) {
        // Try simpler match if states/NBT are missing (handles cases like 'fill ~ ~ ~ ~ ~ ~ air')
        const simpleMatch = line.match(/^(setblock|fill)\s+((?:~?-?\d*\s*){3})\s*(?:((?:~?-?\d*\s*){3})\s+)?([\w:]+)$/);
        if (simpleMatch) {
             const [, commandType, coords1, coords2Raw, blockId] = simpleMatch;
             const coords2 = coords2Raw ? coords2Raw.trim() : null;
             // Ensure states is an empty object, not null/undefined
             return { type: commandType, coords1: coords1.trim(), coords2: coords2, blockId: blockId.trim(), states: {}, nbt: null, originalLine: line };
        }
        console.warn(`Warning: Could not parse Java command line: ${line}`);
        return null;
    }

    const [, commandType, coords1, coords2Raw, blockId, stateString, nbtString] = match;
    const coords2 = coords2Raw ? coords2Raw.trim() : null;

    const states = {};
    if (stateString !== undefined && stateString !== null) {
        // Split by comma, but be careful not to split inside quotes if they existed (though standard format usually doesn't have quoted keys/values here)
        stateString.split(',').forEach(pair => {
            if (!pair) return;
            const parts = pair.split('=');
            if (parts.length === 2) {
                const key = parts[0].trim();
                let value = parts[1].trim();
                // Remove surrounding quotes if present (standard block states aren't quoted like this, but handle just in case)
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.substring(1, value.length - 1);
                }
                states[key] = value;
            } else if (parts.length === 1 && parts[0].trim()) {
                // Handle boolean states potentially written without "=true" (less common but possible)
                // For safety, we'll just log a warning here. Assume standard key=value.
                 console.warn(`Warning: Malformed state pair in '${line}': ${pair}. Treating as invalid.`);
            }
        });
    }

    const nbt = nbtString ? nbtString.trim() : null;
    // Ensure states is an object even if stateString was null/undefined
    return { type: commandType, coords1: coords1.trim(), coords2: coords2, blockId: blockId.trim(), states: states || {}, nbt: nbt, originalLine: line };
}


/**
 * Extracts the base block name from a full ID (e.g., "minecraft:stone" -> "stone").
 */
function getBaseBlockName(blockId) {
    if (!blockId) return '';
    return blockId.includes(':') ? blockId.split(':')[1] : blockId;
}

/**
 * Safely parses potentially escaped JSON string values *from the mapping files*.
 */
function parseJsonStringValue(value) {
    if (typeof value !== 'string') return value;
    try {
        // Attempt to parse assuming it might be a JSON string like "\"true\"" or "\"west\""
        const parsed = JSON.parse(value);
        // Return the parsed value ONLY if it resulted in a primitive (string, number, boolean)
        // Otherwise, return the original string (it might be something like "0b" which isn't valid JSON)
        if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean') {
            return parsed;
        }
        return value;
    } catch (e) {
        // If JSON.parse fails, it's likely a literal string like "west", "0b", "1"
        return value;
    }
}


/**
 * Converts a Java command block representation to its Universal format
 */
async function javaToUniversal(parsedCommand) {
    if (!parsedCommand || !parsedCommand.blockId) {
        console.error('Invalid parsedCommand provided to javaToUniversal:', parsedCommand);
        return null; // Return null on invalid input
    }

    const baseBlockName = getBaseBlockName(parsedCommand.blockId);
    // Use relative paths for mapping files
    const mapFilePath = join(JAVA_MAP_DIR, `${baseBlockName}.json`);
    const rules = await loadJsonMap(mapFilePath);

    // Default structure if no rules found or rules fail
    const defaultUniversal = {
        name: `universal_minecraft:${baseBlockName}`,
        properties: parsedCommand.states || {}, // Ensure properties is an object
        nbt: parsedCommand.nbt
    };

    if (!rules) {
        console.warn(`No Java->Universal mapping rules found for ${baseBlockName}. Using default Universal format.`);
        return defaultUniversal;
    }

    const universalBlock = {
        name: `universal_minecraft:${baseBlockName}`, // Start with default name
        properties: {}, // Start with empty properties
        nbt: parsedCommand.nbt
    };

    try {
        // First pass: Apply new_block rules
        for (const rule of rules) {
            if (rule.function === 'new_block') {
                universalBlock.name = rule.options;
                // console.log(`Applied new_block: ${universalBlock.name}`); // Debug
                break; // Assuming only one new_block rule is relevant
            }
        }

        // Second pass: Apply property rules
        for (const rule of rules) {
            switch (rule.function) {
                case 'new_properties':
                    // Direct property assignments from the rule
                    Object.assign(universalBlock.properties, rule.options);
                    // console.log(`Applied new_properties:`, rule.options); // Debug
                    break;

                case 'carry_properties':
                    // Carry over properties from Java if they exist and match allowed values
                    for (const propKey in rule.options) {
                        // Java states might or might not have quotes, check both
                        const javaValue = parsedCommand.states[propKey] ?? parsedCommand.states[`"${propKey}"`];

                        if (javaValue !== undefined) {
                            const allowedValues = rule.options[propKey];
                            if (Array.isArray(allowedValues)) {
                                const javaValueStr = String(javaValue).toLowerCase();
                                // Check if the javaValue (as string) exists in the allowed values (after parsing them)
                                const foundMatch = allowedValues.some(allowedValue => {
                                    const parsedAllowed = parseJsonStringValue(allowedValue);
                                    return String(parsedAllowed).toLowerCase() === javaValueStr;
                                });

                                if (foundMatch) {
                                     // Store the original value *from the mapping file* that matched
                                     const matchingAllowedValue = allowedValues.find(allowedValue => String(parseJsonStringValue(allowedValue)).toLowerCase() === javaValueStr);
                                     universalBlock.properties[propKey] = matchingAllowedValue;
                                    // console.log(`Carried property '${propKey}': ${matchingAllowedValue}`); // Debug
                                } else {
                                    // console.log(`Did not carry '${propKey}': Java value '${javaValueStr}' not in allowed list`, allowedValues); // Debug
                                }
                            } else {
                                console.warn(`Invalid format for carry_properties rule options for key '${propKey}' in ${baseBlockName}.json. Expected an array.`);
                            }
                        }
                    }
                    break;

                case 'map_properties':
                    // Handle property mappings based on Java state values
                    for (const propKey in rule.options) {
                        const javaValue = parsedCommand.states[propKey] ?? parsedCommand.states[`"${propKey}"`];
                        // console.log(`map_properties: Checking key '${propKey}', Java value is '${javaValue}'`);// Debug

                        if (javaValue !== undefined) {
                             // Check mapping using the raw Java value and potentially a quoted version
                             const mappingOptions = rule.options[propKey];
                             const mappingForValue = mappingOptions?.[javaValue] ?? mappingOptions?.[`"${javaValue}"`];
                            // console.log(`   Mapping options for '${propKey}':`, mappingOptions); // Debug
                            // console.log(`   Mapping found for value '${javaValue}'?`, !!mappingForValue); // Debug

                            if (mappingForValue && Array.isArray(mappingForValue)) {
                                // Apply nested rules (usually new_properties)
                                for (const nestedRule of mappingForValue) {
                                    if (nestedRule.function === 'new_properties') {
                                        Object.assign(universalBlock.properties, nestedRule.options);
                                        // console.log(`   Applied nested new_properties from map:`, nestedRule.options); // Debug
                                    }
                                    // Potentially handle other nested functions if needed
                                }
                            }
                        }
                    }
                    break;
            }
        }

        // Add any original Java states that weren't explicitly handled by rules
        // (Optional - might be desired, might not. Current logic prioritizes explicit mapping)
        // for (const key in parsedCommand.states) {
        //     if (!(key in universalBlock.properties)) {
        //         universalBlock.properties[key] = parsedCommand.states[key];
        //          console.log(`Added unhandled Java state: ${key}=${parsedCommand.states[key]}`); // Debug
        //     }
        // }


    } catch (error) {
        console.error(`Error applying Java->Universal rules for ${baseBlockName}:`, error);
        console.error('Rule being processed might be near:', error.rule || 'N/A'); // Log rule if possible
        return defaultUniversal; // Return default on error during rule processing
    }

    // console.log(`Final Universal for ${baseBlockName}:`, JSON.stringify(universalBlock, null, 2)); // Final debug
    return universalBlock;
}


/**
 * Converts a Universal format block to its Bedrock representation
 */
async function universalToBedrock(originalCommand, universalBlock) {
    if (!universalBlock || !universalBlock.name) {
        console.error('Invalid universalBlock provided to universalToBedrock:', universalBlock);
        return null;
    }
    if (!originalCommand || !originalCommand.type) {
        console.error('Invalid originalCommand provided to universalToBedrock');
        return null;
    }

    const baseUniversalName = getBaseBlockName(universalBlock.name);
    // Use relative paths for mapping files
    const mapFilePath = join(BEDROCK_MAP_DIR, `${baseUniversalName}.json`);
    const rules = await loadJsonMap(mapFilePath);

    // Initialize Bedrock representation using original command structure
    const bedrockRepresentation = {
        type: originalCommand.type,
        coords1: originalCommand.coords1,
        coords2: originalCommand.coords2, // Will be null for setblock
        name: `minecraft:${baseUniversalName}`, // Default name
        states: {},
        nbt: universalBlock.nbt // Carry over NBT if it exists
    };

    if (!rules) {
        console.warn(`No Universal->Bedrock mapping rules found for ${baseUniversalName}. Using default name and potentially no states.`);
        // Attempt to carry over any universal properties directly as a fallback
        // This might not result in valid Bedrock states, but it's better than nothing.
        for (const key in universalBlock.properties) {
             bedrockRepresentation.states[key] = parseJsonStringValue(universalBlock.properties[key]); // Use parsed value
        }
        return bedrockRepresentation;
    }

    try {
         // Helper function to recursively apply nested rules
         function applyNestedRules(nestedRules, currentBedrockRep, universalProps) {
             if (!Array.isArray(nestedRules)) return;

             for (const rule of nestedRules) {
                 switch (rule.function) {
                     case 'new_block':
                         currentBedrockRep.name = rule.options;
                         // console.log(`Nested new_block: ${currentBedrockRep.name}`); // Debug
                         break;
                     case 'new_properties':
                         // Clean up property values by removing extra quotes *if they are strings*
                         for (const [key, value] of Object.entries(rule.options)) {
                             if (typeof value === 'string') {
                                 // Use parseJsonStringValue to handle "\"true\"" -> true, "\"1\"" -> 1, "\"foo\"" -> "foo", "0b" -> "0b"
                                 currentBedrockRep.states[key] = parseJsonStringValue(value);
                             } else {
                                 currentBedrockRep.states[key] = value; // Keep numbers/booleans as is
                             }
                         }
                         // console.log(`Nested new_properties applied:`, currentBedrockRep.states); // Debug
                         break;
                     case 'map_properties':
                         // Handle nested property mappings
                         for (const propKey in rule.options) {
                             const universalValue = universalProps[propKey];
                             if (universalValue !== undefined) {
                                 // Use the already parsed universal value for matching
                                 const cleanValue = parseJsonStringValue(universalValue);

                                 // Try matching against the mapping keys (which are usually strings from JSON)
                                 // The mapping keys might represent numbers, booleans, or strings.
                                 let mappingForValue = rule.options[propKey]?.[String(cleanValue)]; // Try direct string match first
                                  if (!mappingForValue && typeof cleanValue === 'string') {
                                      // If it was a string, try matching against the quoted version too
                                      mappingForValue = rule.options[propKey]?.[`"${cleanValue}"`];
                                  }

                                 if (mappingForValue && Array.isArray(mappingForValue)) {
                                     applyNestedRules(mappingForValue, currentBedrockRep, universalProps);
                                 }
                             }
                         }
                         break;
                     // Add cases for other potential nested functions like 'carry_properties' if needed
                     case 'carry_properties':
                           // Handle direct property carry-over within nested rules
                           for (const propKey in rule.options) {
                                const universalValue = universalProps[propKey];
                                if (universalValue !== undefined) {
                                     // Check if the carried value is allowed
                                     const allowedValues = rule.options[propKey];
                                     if (Array.isArray(allowedValues)) {
                                         const parsedUniversalValue = parseJsonStringValue(universalValue);
                                         const valueStr = String(parsedUniversalValue).toLowerCase();
                                         const isAllowed = allowedValues.some(allowed => String(parseJsonStringValue(allowed)).toLowerCase() === valueStr);
                                         if (isAllowed) {
                                             currentBedrockRep.states[propKey] = parsedUniversalValue; // Store the parsed universal value
                                             // console.log(`Nested carried property '${propKey}': ${parsedUniversalValue}`); // Debug
                                         }
                                     }
                                }
                            }
                            break;
                 }
             }
         }


        // --- Main Rule Application Logic ---

        // 1. Set initial block name based on top-level 'new_block'
        const newBlockRule = rules.find(rule => rule.function === 'new_block');
        if (newBlockRule) {
            bedrockRepresentation.name = newBlockRule.options;
            // console.log(`Initial Bedrock name set: ${bedrockRepresentation.name}`); // Debug
        }

        // 2. Apply top-level 'new_properties'
        const newPropsRules = rules.filter(rule => rule.function === 'new_properties');
        for (const rule of newPropsRules) {
             applyNestedRules([rule], bedrockRepresentation, universalBlock.properties); // Reuse helper
        }

        // 3. Apply top-level 'carry_properties'
         const carryPropsRule = rules.find(rule => rule.function === 'carry_properties');
         if (carryPropsRule) {
             applyNestedRules([carryPropsRule], bedrockRepresentation, universalBlock.properties); // Reuse helper
         }

        // 4. Apply top-level 'map_properties'
        const mapPropsRule = rules.find(rule => rule.function === 'map_properties');
        if (mapPropsRule) {
            applyNestedRules([mapPropsRule], bedrockRepresentation, universalBlock.properties); // Reuse helper
        }

    } catch (error) {
        console.error(`Error applying Universal->Bedrock rules for ${baseUniversalName}:`, error);
        // Fallback to default representation on error
        return {
            type: originalCommand.type,
            coords1: originalCommand.coords1,
            coords2: originalCommand.coords2,
            name: `minecraft:${baseUniversalName}`, // Default name
            states: {}, // Empty states on error
            nbt: universalBlock.nbt
        };
    }

    // console.log(`Final Bedrock for ${baseUniversalName}:`, JSON.stringify(bedrockRepresentation, null, 2)); // Final debug
    return bedrockRepresentation;
}


/**
 * Formats the Bedrock representation into a command string.
 */
function formatBedrockCommand(bedrockRep) {
    if (!bedrockRep || !bedrockRep.type || !bedrockRep.coords1 || !bedrockRep.name) {
        console.error("Invalid Bedrock representation for formatting:", bedrockRep);
        return null; // Cannot format incomplete data
    }

    let commandStr = `${bedrockRep.type} ${bedrockRep.coords1}`;
    if (bedrockRep.type === 'fill' && bedrockRep.coords2) {
        commandStr += ` ${bedrockRep.coords2}`;
    }
    commandStr += ` ${bedrockRep.name}`;

    const stateKeys = Object.keys(bedrockRep.states || {});
    if (stateKeys.length > 0) {
         const stateParts = stateKeys.map(key => {
             let value = bedrockRep.states[key];

             // Bedrock state keys are typically quoted strings
             let formattedKey = `"${key}"`;
             let formattedValue;

             // Format values based on type for Bedrock states
             if (typeof value === 'boolean') {
                 formattedValue = value.toString(); // 'true' or 'false' (unquoted)
             } else if (typeof value === 'number') {
                 if (Number.isInteger(value)) {
                    formattedValue = value; // Integer (unquoted)
                 } else {
                    // Non-integer numbers are usually not valid block states.
                    // Representing as string might be safer, though likely incorrect for the game.
                    console.warn(`Warning: Non-integer number state value '${value}' for key '${key}'. Formatting as string.`);
                    formattedValue = `"${value}"`;
                 }
             } else if (typeof value === 'string') {
                 // Handle specific known pseudo-boolean/numeric strings from mappings
                 if (value === "0b") {
                     formattedValue = false; // Treat "0b" as boolean false
                 } else if (value === "1b") {
                     formattedValue = true; // Treat "1b" as boolean true
                 } else {
                      // Check if the string represents an integer
                      const intVal = parseInt(value, 10);
                      if (!isNaN(intVal) && String(intVal) === value) {
                           formattedValue = intVal; // String is an integer, use number
                      } else {
                           // Otherwise, treat as a literal string state (e.g., "stone", "north") and quote it
                           formattedValue = `"${value}"`;
                      }
                 }
             } else {
                 // Handle unexpected types if necessary
                 console.warn(`Warning: Unexpected state value type '${typeof value}' for key '${key}'. Formatting as string.`);
                 formattedValue = `"${String(value)}"`;
             }

             return `${formattedKey}=${formattedValue}`;
         });
         commandStr += ` [${stateParts.join(',')}]`;
     }
     // Note: NBT translation ('bedrockRep.nbt') is complex and not implemented here.
     // Appending Java NBT directly is usually incorrect for Bedrock.
     if (bedrockRep.nbt) {
         console.warn(`Warning: NBT data found but translation is not supported. NBT ignored for Bedrock command: ${bedrockRep.nbt}`);
     }

    return commandStr;
}

// Export necessary functions for server.js
export {
    parseJavaCommand,
    javaToUniversal,
    universalToBedrock,
    formatBedrockCommand
};