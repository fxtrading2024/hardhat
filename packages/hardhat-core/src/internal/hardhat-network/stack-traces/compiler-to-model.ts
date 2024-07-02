import debug from "debug";

import {
  correctSelectors,
  astSrcToSourceLocation,
  processModifierDefinitionAstNode,
  processVariableDeclarationAstNode,
  astVisibilityToVisibility,
  isEnumType,
  isContractType,
  toCanonicalAbiType,
} from "@nomicfoundation/edr";
import {
  CompilerInput,
  CompilerOutput,
  CompilerOutputBytecode,
} from "../../../types";

import {
  getLibraryAddressPositions,
  normalizeCompilerOutputBytecode,
} from "./library-utils";
import {
  Bytecode,
  Contract,
  ContractFunction,
  ContractFunctionType,
  ContractFunctionVisibility,
  ContractType,
  CustomError,
  SourceFile,
} from "./model";
import { decodeInstructions } from "./source-maps";

const abi = require("ethereumjs-abi");

const log = debug("hardhat:core:hardhat-network:compiler-to-model");

interface ContractAbiEntry {
  name?: string;
  inputs?: Array<{
    type: string;
  }>;
}

type ContractAbi = ContractAbiEntry[];

export function createModelsAndDecodeBytecodes(
  solcVersion: string,
  compilerInput: CompilerInput,
  compilerOutput: CompilerOutput
): Bytecode[] {
  const fileIdToSourceFile = new Map<number, SourceFile>();
  const contractIdToContract = new Map<number, Contract>();

  createSourcesModelFromAst(
    compilerOutput,
    compilerInput,
    fileIdToSourceFile,
    contractIdToContract
  );

  const bytecodes = decodeBytecodes(
    solcVersion,
    compilerOutput,
    fileIdToSourceFile,
    contractIdToContract
  );

  correctSelectors(bytecodes, compilerOutput);

  return bytecodes;
}

function createSourcesModelFromAst(
  compilerOutput: CompilerOutput,
  compilerInput: CompilerInput,
  fileIdToSourceFile: Map<number, SourceFile>,
  contractIdToContract: Map<number, Contract>
) {
  const contractIdToLinearizedBaseContractIds = new Map<number, number[]>();

  // Create a `sourceName => contractName => abi` mapping
  const sourceNameToContractToAbi = new Map<string, Map<string, ContractAbi>>();
  for (const [sourceName, contracts] of Object.entries(
    compilerOutput.contracts
  )) {
    const contractToAbi = new Map<string, ContractAbi>();
    sourceNameToContractToAbi.set(sourceName, contractToAbi);
    for (const [contractName, contract] of Object.entries(contracts)) {
      contractToAbi.set(contractName, contract.abi);
    }
  }

  for (const [sourceName, source] of Object.entries(compilerOutput.sources)) {
    const contractToAbi = sourceNameToContractToAbi.get(sourceName);
    const file = new SourceFile(
      sourceName,
      compilerInput.sources[sourceName].content
    );

    // Should return a
    // - list of source files
    // - mapping of file id to the source file
    // - and the contract name to abi mapping?

    // Are we sure this is in a topological order?
    // Otherwise it'd be more correct to first process all the sources
    // and only then process the contracts using the fileIdToSourceFile map
    fileIdToSourceFile.set(source.id, file);

    for (const node of source.ast.nodes) {
      if (node.nodeType === "ContractDefinition") {
        const contractType = contractKindToContractType(node.contractKind);
        if (contractType === undefined) {
          continue;
        }

        const contractAbi = contractToAbi?.get(node.name);

        processContractAstNode(
          file,
          node,
          fileIdToSourceFile,
          contractType,
          contractIdToContract,
          contractIdToLinearizedBaseContractIds,
          contractAbi
        );
      }

      // top-level functions
      if (node.nodeType === "FunctionDefinition") {
        processFunctionDefinitionAstNode(
          node,
          fileIdToSourceFile,
          undefined,
          file
        );
      }
    }
  }

  applyContractsInheritance(
    contractIdToContract,
    contractIdToLinearizedBaseContractIds
  );
}

function processContractAstNode(
  file: SourceFile,
  contractNode: any,
  fileIdToSourceFile: Map<number, SourceFile>,
  contractType: ContractType,
  contractIdToContract: Map<number, Contract>,
  contractIdToLinearizedBaseContractIds: Map<number, number[]>,
  contractAbi?: ContractAbi
) {
  const contractLocation = astSrcToSourceLocation(
    contractNode.src,
    fileIdToSourceFile
  )!;

  const contract = new Contract(
    contractNode.name,
    contractType,
    contractLocation
  );

  contractIdToContract.set(contractNode.id, contract);
  contractIdToLinearizedBaseContractIds.set(
    contractNode.id,
    contractNode.linearizedBaseContracts
  );

  for (const node of contractNode.nodes) {
    if (node.nodeType === "FunctionDefinition") {
      const functionAbis = contractAbi?.filter(
        (abiEntry) => abiEntry.name === node.name
      );

      processFunctionDefinitionAstNode(
        node,
        fileIdToSourceFile,
        contract,
        file,
        functionAbis
      );
    } else if (node.nodeType === "ModifierDefinition") {
      processModifierDefinitionAstNode(
        node,
        fileIdToSourceFile,
        contract,
        file
      );
    } else if (node.nodeType === "VariableDeclaration") {
      const getterAbi = contractAbi?.find(
        (abiEntry) => abiEntry.name === node.name
      );
      processVariableDeclarationAstNode(
        node,
        fileIdToSourceFile,
        contract,
        file,
        getterAbi
      );
    }
  }
}

function processFunctionDefinitionAstNode(
  functionDefinitionNode: any,
  fileIdToSourceFile: Map<number, SourceFile>,
  contract: Contract | undefined,
  file: SourceFile,
  functionAbis?: ContractAbiEntry[]
) {
  if (functionDefinitionNode.implemented === false) {
    return;
  }

  const functionType = functionDefinitionKindToFunctionType(
    functionDefinitionNode.kind
  );
  const functionLocation = astSrcToSourceLocation(
    functionDefinitionNode.src,
    fileIdToSourceFile
  )!;
  const visibility = astVisibilityToVisibility(
    functionDefinitionNode.visibility
  );

  let selector: Buffer | undefined;
  if (
    functionType === ContractFunctionType.FUNCTION &&
    (visibility === ContractFunctionVisibility.EXTERNAL ||
      visibility === ContractFunctionVisibility.PUBLIC)
  ) {
    selector = astFunctionDefinitionToSelector(functionDefinitionNode);
  }

  // function can be overloaded, match the abi by the selector
  const matchingFunctionAbi = functionAbis?.find((functionAbi) => {
    if (functionAbi.name === undefined) {
      return false;
    }

    const functionAbiSelector = abi.methodID(
      functionAbi.name,
      functionAbi.inputs?.map((input) => input.type) ?? []
    );

    if (selector === undefined || functionAbiSelector === undefined) {
      return false;
    }

    return selector.equals(functionAbiSelector);
  });

  const paramTypes = matchingFunctionAbi?.inputs?.map((input) => input.type);

  const contractFunc = new ContractFunction(
    functionDefinitionNode.name,
    functionType,
    functionLocation,
    contract,
    visibility,
    functionDefinitionNode.stateMutability === "payable",
    selector,
    paramTypes
  );

  if (contract !== undefined) {
    contract.addLocalFunction(contractFunc);
  }

  file.addFunction(contractFunc);
}


function applyContractsInheritance(
  contractIdToContract: Map<number, Contract>,
  contractIdToLinearizedBaseContractIds: Map<number, number[]>
) {
  for (const [cid, contract] of contractIdToContract.entries()) {
    const inheritanceIds = contractIdToLinearizedBaseContractIds.get(cid)!;

    for (const baseId of inheritanceIds) {
      const baseContract = contractIdToContract.get(baseId);

      if (baseContract === undefined) {
        // This list includes interface, which we don't model
        continue;
      }

      contract.addNextLinearizedBaseContract(baseContract);
    }
  }
}

function decodeBytecodes(
  solcVersion: string,
  compilerOutput: CompilerOutput,
  fileIdToSourceFile: Map<number, SourceFile>,
  contractIdToContract: Map<number, Contract>
): Bytecode[] {
  const bytecodes: Bytecode[] = [];

  for (const contract of contractIdToContract.values()) {
    const contractFile = contract.location.file.sourceName;
    const contractEvmOutput =
      compilerOutput.contracts[contractFile][contract.name].evm;
    const contractAbiOutput =
      compilerOutput.contracts[contractFile][contract.name].abi;

    for (const abiItem of contractAbiOutput) {
      if (abiItem.type === "error") {
        const customError = CustomError.fromABI(abiItem.name, abiItem.inputs);

        if (customError !== undefined) {
          contract.addCustomError(customError);
        } else {
          log(`Couldn't build CustomError for error '${abiItem.name}'`);
        }
      }
    }

    // This is an abstract contract
    if (contractEvmOutput.bytecode.object === "") {
      continue;
    }

    const deploymentBytecode = decodeEvmBytecode(
      contract,
      solcVersion,
      true,
      contractEvmOutput.bytecode,
      fileIdToSourceFile
    );

    const runtimeBytecode = decodeEvmBytecode(
      contract,
      solcVersion,
      false,
      contractEvmOutput.deployedBytecode,
      fileIdToSourceFile
    );

    bytecodes.push(deploymentBytecode);
    bytecodes.push(runtimeBytecode);
  }

  return bytecodes;
}

function decodeEvmBytecode(
  contract: Contract,
  solcVersion: string,
  isDeployment: boolean,
  compilerBytecode: CompilerOutputBytecode,
  fileIdToSourceFile: Map<number, SourceFile>
): Bytecode {
  const libraryAddressPositions = getLibraryAddressPositions(compilerBytecode);

  const immutableReferences =
    compilerBytecode.immutableReferences !== undefined
      ? Object.values(compilerBytecode.immutableReferences).reduce(
          (previousValue, currentValue) => [...previousValue, ...currentValue],
          []
        )
      : [];

  const normalizedCode = normalizeCompilerOutputBytecode(
    compilerBytecode.object,
    libraryAddressPositions
  );

  const instructions = decodeInstructions(
    normalizedCode,
    compilerBytecode.sourceMap,
    fileIdToSourceFile,
    isDeployment
  );

  return new Bytecode(
    contract,
    isDeployment,
    normalizedCode,
    instructions,
    libraryAddressPositions,
    immutableReferences,
    solcVersion
  );
}

function contractKindToContractType(
  contractKind?: string
): ContractType | undefined {
  if (contractKind === "library") {
    return ContractType.LIBRARY;
  }

  if (contractKind === "contract") {
    return ContractType.CONTRACT;
  }

  return undefined;
}

function functionDefinitionKindToFunctionType(
  kind: string | undefined
): ContractFunctionType {
  if (kind === "constructor") {
    return ContractFunctionType.CONSTRUCTOR;
  }

  if (kind === "fallback") {
    return ContractFunctionType.FALLBACK;
  }

  if (kind === "receive") {
    return ContractFunctionType.RECEIVE;
  }

  if (kind === "freeFunction") {
    return ContractFunctionType.FREE_FUNCTION;
  }

  return ContractFunctionType.FUNCTION;
}

function astFunctionDefinitionToSelector(functionDefinition: any): Buffer {
  const paramTypes: string[] = [];

  // The function selector is available in solc versions >=0.6.0
  if (functionDefinition.functionSelector !== undefined) {
    return Buffer.from(functionDefinition.functionSelector, "hex");
  }

  for (const param of functionDefinition.parameters.parameters) {
    if (isContractType(param)) {
      paramTypes.push("address");
      continue;
    }

    // TODO: implement ABIv2 structs parsing
    // This might mean we need to parse struct definitions before
    // resolving types and trying to calculate function selectors.
    // if (isStructType(param)) {
    //   paramTypes.push(something);
    //   continue;
    // }

    if (isEnumType(param)) {
      // TODO: If the enum has >= 256 elements this will fail. It should be a uint16. This is
      //  complicated, as enums can be inherited. Fortunately, if multiple parent contracts
      //  define the same enum, solc fails to compile.
      paramTypes.push("uint8");
      continue;
    }

    // The rest of the function parameters always have their typeName node defined
    const typename = param.typeName;
    if (
      typename.nodeType === "ArrayTypeName" ||
      typename.nodeType === "FunctionTypeName" ||
      typename.nodeType === "Mapping"
    ) {
      paramTypes.push(typename.typeDescriptions.typeString);
      continue;
    }

    paramTypes.push(toCanonicalAbiType(typename.name));
  }

  return abi.methodID(functionDefinition.name, paramTypes);
}
