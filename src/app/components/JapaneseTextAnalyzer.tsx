"use client"
import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as kuromoji from 'kuromoji';
import * as d3 from 'd3';
import { homonymMap, homonymExamples } from '../data/homonymData';

interface NgramResults {
  [key: number]: string[];
}

interface SelectedWords {
  [key: string]: boolean; // 色の状態ではなく、選択/非選択のみを管理
}

interface TreeNode {
  id: string;
  name: string;
  children?: TreeNode[];
  size?: number;
  connections?: { source: string, target: string }[];
}

// 同音異義語候補のインターフェース
interface HomonymCandidate {
  original: string;    // 元のテキスト
  homonym: string;     // 同音異義語
  meaning?: string;    // 意味
  example?: string;    // 用例
}

// デザインテーマの定数
const THEME = {
  colors: {
    primary: '#3b82f6',       // メインカラー
    secondary: '#6366f1',     // 選択時の色
    success: '#10b981',       // 成功/同音異義語置換済みの色
    warning: '#f59e0b',       // 注意/同音異義語候補ありの色
    light: '#f3f4f6',         // 背景色（明るい）
    dark: '#1f2937',          // テキスト色（暗い）
    white: '#ffffff',         // 白色
    gray: {
      100: '#f9fafb',
      200: '#e5e7eb',
      300: '#d1d5db',
      400: '#9ca3af',
      500: '#6b7280',
      600: '#4b5563',
      700: '#374151'          // 追加: より暗いグレー
    }
  },
  fontSizes: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem'
  },
  spacing: {
    1: '0.25rem',
    2: '0.5rem',
    3: '0.75rem',
    4: '1rem',
    5: '1.25rem',
    6: '1.5rem',
    8: '2rem',
    10: '2.5rem'
  },
  borderRadius: {
    sm: '0.25rem',
    md: '0.375rem',
    lg: '0.5rem',
    full: '9999px'
  },
  shadows: {
    sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
    md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)'
  }
};

const JapaneseTextAnalyzer: React.FC = () => {
  // 主要なstate
  const [inputText, setInputText] = useState<string>('ここに文字列を入力');
  const [hiraganaText, setHiraganaText] = useState<string>('');
  const [ngramValue, setNgramValue] = useState<number>(1);
  const [mgramValue, setMgramValue] = useState<number>(3);
  const [ngramResults, setNgramResults] = useState<NgramResults>({});
  const [selectedWords, setSelectedWords] = useState<SelectedWords>({});
  const [tokenizer, setTokenizer] = useState<kuromoji.Tokenizer<kuromoji.IpadicFeatures> | null>(null);
  const [treeData, setTreeData] = useState<TreeNode | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  
  // 同音異義語関連のステート
  const [homonymCandidates, setHomonymCandidates] = useState<HomonymCandidate[]>([]);
  const [showHomonymPopup, setShowHomonymPopup] = useState<boolean>(false);
  const [homonymPopupPosition, setHomonymPopupPosition] = useState<{x: number, y: number}>({x: 0, y: 0});
  const [selectedNgram, setSelectedNgram] = useState<string>('');
  // N-gramノードでの同音異義語置換を追跡するためのマップ
  const [ngramHomonymReplacement, setNgramHomonymReplacement] = useState<{[key: string]: string}>({});
  // N-gram文字列に対する同音異義語候補の有無をキャッシュするマップ
  const [homonymCandidateCache, setHomonymCandidateCache] = useState<{[key: string]: boolean}>({});

  // 日本語テキストから同音異義語へのマッピングは../data/homonymData.tsに定義しています

  // 形態素解析器の初期化
  useEffect(() => {
    const initializeTokenizer = async () => {
      try {
        const builder = kuromoji.builder({ dicPath: '/dict' });
        const tokenizer = await new Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>>((resolve, reject) => {
          builder.build((err, tokenizer) => {
            if (err) {
              reject(err);
            } else {
              resolve(tokenizer);
            }
          });
        });
        setTokenizer(tokenizer);
      } catch (err: unknown) {
        console.error('Tokenizer initialization failed:', err);
      }
    };

    initializeTokenizer();
  }, []);

  // テキストをひらがなに変換
  const convertToHiragana = useCallback((text: string): string => {
    if (!tokenizer) return text;

    try {
      // テキストを形態素解析
      const tokens = tokenizer.tokenize(text);
      
      // 各形態素の読みを取得して結合
      return tokens
        .map(token => {
          // 読みが存在する場合はその読みを使用
          if (token.reading) {
            return convertKatakanaToHiragana(token.reading);
          }
          // 読みが存在しない場合は元のテキストをそのままカタカナ変換の対象にする
          return convertKatakanaToHiragana(token.surface_form);
        })
        .join('');
    } catch (error) {
      console.error('Text conversion failed:', error);
      // エラーがあった場合も、カタカナ変換を試みる
      return convertKatakanaToHiragana(text);
    }
  }, [tokenizer]);

  // カタカナをひらがなに変換
  const convertKatakanaToHiragana = (text: string): string => {
    // カタカナ→ひらがな変換（\u30A1-\u30F6 がカタカナの範囲）
    return text.replace(/[\u30A1-\u30F6]/g, match => {
      return String.fromCharCode(match.charCodeAt(0) - 0x60);
    });
  };

  // 単語から同音異義語候補を探す
  const findHomonymCandidates = (word: string): HomonymCandidate[] => {
    const candidates: HomonymCandidate[] = [];
    const hiragana = convertKatakanaToHiragana(word);
    
    console.log('Finding homonyms for:', hiragana);
    
    // 完全一致のみを探す
    if (homonymMap[hiragana]) {
      console.log('Found exact match for:', hiragana);
      homonymMap[hiragana].forEach(homonym => {
        // 同音異義語の意味と例を取得
        const homonymInfo = homonymExamples[hiragana]?.find(info => 
          info.meaning.startsWith(homonym)) || { meaning: homonym, example: '' };
        
        candidates.push({
          original: word,
          homonym: homonym,
          meaning: homonymInfo.meaning,
          example: homonymInfo.example
        });
      });
      
      console.log('Returning exact matches only:', candidates.length);
    }
    
    // 完全一致のみを返し、部分一致は考慮しない
    console.log('Total candidates found:', candidates.length);
    return candidates;
  };

  // 絵文字を適用する関数
  const applyHomonym = (homonym: string) => {
    // 選択中のN-gramを絵文字に置換して記録
    const newReplacements = {
      ...ngramHomonymReplacement,
      [selectedNgram]: homonym
    };
    
    // 上位のN-gramに変更を伝播
    propagateHomonymReplacementToParents(selectedNgram, homonym, newReplacements);
    
    // 更新された置換情報を設定
    setNgramHomonymReplacement(newReplacements);
    
    // ポップアップを閉じる
    closeHomonymPopup();
  };

  // 絵文字置換を上位のN-gramに伝播させる関数
  const propagateHomonymReplacementToParents = (
    ngram: string, 
    homonym: string, 
    replacements: {[key: string]: string}
  ) => {
    // 全てのN-gramサイズを処理
    Object.entries(ngramResults).forEach(([sizeStr, ngramsArray]) => {
      const size = parseInt(sizeStr);
      
      // 現在のサイズが元のN-gramのサイズより大きい場合のみ処理
      if (size > ngram.length) {
        ngramsArray.forEach((parentNgram: string) => {
          // 親N-gramが変更対象のN-gramを含む場合
          if (parentNgram.includes(ngram)) {
            // 親N-gramの中での位置を特定
            const position = parentNgram.indexOf(ngram);
            
            // 親N-gramの該当部分を絵文字に置換
            if (position !== -1) {
              // 親N-gramを3つの部分に分割して置換
              const prefix = parentNgram.substring(0, position);
              const suffix = parentNgram.substring(position + ngram.length);
              
              // 既に絵文字置換されている部分があれば考慮
              const newParentText = applyExistingReplacements(prefix, replacements) + 
                                  homonym + 
                                  applyExistingReplacements(suffix, replacements);
              
              // 置換結果を記録
              replacements[parentNgram] = newParentText;
            }
          }
        });
      }
    });
  };

  // 既存の絵文字置換を適用する補助関数
  const applyExistingReplacements = (text: string, replacements: {[key: string]: string}): string => {
    let result = text;
    
    // 置換マップのキーを長さの降順でソート（長いものから先に処理）
    const keys = Object.keys(replacements).sort((a, b) => b.length - a.length);
    
    // 該当する置換がある場合、適用
    for (const key of keys) {
      if (text.includes(key)) {
        result = result.replace(key, replacements[key]);
      }
    }
    
    return result;
  };

  // 絵文字ポップアップを閉じる
  const closeHomonymPopup = () => {
    setShowHomonymPopup(false);
    setHomonymCandidates([]);
    setSelectedNgram('');
  };

  // N-gramノードをクリックしたときの処理（選択状態のみ切り替え）
  const toggleNgramSelection = (ngram: string) => {
    // 選択状態を切り替え
    setSelectedWords(prev => ({
      ...prev,
      [ngram]: !prev[ngram]
    }));
  };

  // N-gram生成機能
  const generateNgrams = (text: string, n: number, m: number): NgramResults => {
    // Ensure n and m are within constraints
    const validN = Math.max(1, Math.min(n, 5));
    const validM = Math.max(validN, Math.min(m, 5));
    
    const results: NgramResults = {};
    
    // n から m までの各サイズのN-gramを生成
    for (let size = validN; size <= validM; size++) {
      const ngrams: string[] = [];
      for (let i = 0; i <= text.length - size; i++) {
        const ngram = text.slice(i, i + size);
        ngrams.push(ngram);
      }
      results[size] = ngrams;
    }
    
    return results;
  };

  // N-Mgram ツリーデータの生成
  const generateTreeData = useCallback((): TreeNode => {
    // 階層構造を作り直す
    const rootNode: TreeNode = {
      id: 'root',
      name: inputText,
      children: []
    };

    // N-gramサイズの降順でデータを処理（大きいサイズから小さいサイズへ）
    const sizes = Object.keys(ngramResults)
      .map(Number)
      .sort((a, b) => b - a); // 降順ソート

    if (sizes.length === 0) return rootNode;

    // 層ごとのノードを保存するオブジェクト
    const layerNodes: { [key: string]: TreeNode } = {};
    
    // 全N-gramノードを保存するオブジェクト（IDからノードを素早く取得するため）
    const nodeMap: { [key: string]: TreeNode } = {};
    
    // 接続情報を保存する配列
    const connections: { source: string, target: string }[] = [];

    // 1. まず全ての層ノードをrootの下に配置
    sizes.forEach(size => {
      const layerNode: TreeNode = {
        id: `layer-${size}`,
        name: `${size}-gram`,
        children: []
      };
      rootNode.children?.push(layerNode);
      layerNodes[`layer-${size}`] = layerNode;
    });
    
    // 2. 各N-gramをそれぞれの層ノードの下に配置し、nodeMapに登録
    sizes.forEach(size => {
      const layerNode = layerNodes[`layer-${size}`];
      const ngrams = ngramResults[size] || [];
      
      ngrams.forEach((ngram, index) => {
        const ngramNode: TreeNode = {
          id: `${size}-${index}`,
          name: ngram,
          size: selectedWords[ngram] ? 100 : 50,
          children: []
        };
        
        // 層ノードの下に配置
        layerNode.children?.push(ngramNode);
        
        // ノードマップに登録
        nodeMap[`${size}-${index}`] = ngramNode;
      });
    });
    
    // 3. N-gram間の接続関係を計算
    sizes.forEach((size, layerIndex) => {
      // 最小サイズのN-gramは処理不要（これより小さいサイズはないため）
      if (layerIndex === sizes.length - 1) return;
      
      const nextSize = sizes[layerIndex + 1];
      const currentNgrams = ngramResults[size] || [];
      const nextNgrams = ngramResults[nextSize] || [];
      
      // 現在の層の各N-gramについて
      currentNgrams.forEach((currentNgram, currentIndex) => {
        const sourceId = `${size}-${currentIndex}`;
        
        // 次の層の各N-gramについて
        nextNgrams.forEach((nextNgram, nextIndex) => {
          const targetId = `${nextSize}-${nextIndex}`;
          
          // 部分文字列の関係をチェック（次の層のN-gramが現在のN-gramの部分文字列かどうか）
          if (currentNgram.includes(nextNgram)) {
            // 現在のN-gram内での位置を特定
            const position = currentNgram.indexOf(nextNgram);
            
            // 位置が連続している場合のみ接続（0または1の差）
            // 例: "あいう"の"あい"と"いう"は接続するが、"あう"は接続しない
            if (position === 0 || position + nextNgram.length === currentNgram.length || 
                (position > 0 && position < currentNgram.length - nextNgram.length)) {
              connections.push({
                source: sourceId,
                target: targetId
              });
            }
          }
        });
      });
    });
    
    // 接続情報をrootNodeに保存
    rootNode.connections = connections;
    
    return rootNode;
  }, [ngramResults, selectedWords, inputText]);

  // ツリー可視化の描画
  const drawTree = useCallback(() => {
    if (!svgRef.current || !treeData) return;

    // 以前の描画をクリア
    d3.select(svgRef.current).selectAll('*').remove();

    const width = 1000;  // 幅を広げる
    const height = 700;  // 高さを広げる

    // SVGのサイズ設定
    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height)
      .append('g')
      .attr('transform', `translate(60, 20)`);

    // 定数
    const COLORS = {
      rootNode: THEME.colors.primary,
      ngramNode: THEME.colors.gray[200],      // 未選択: 薄いグレー
      selectedNode: THEME.colors.secondary,  // 選択時: インディゴ
      connection: THEME.colors.gray[400],    // 接続線: 中間のグレー
      layerLabel: THEME.colors.primary,      // レイヤーラベル
      textLight: THEME.colors.white,        // 白テキスト（暗い背景用）
      textDark: THEME.colors.gray[600],      // 暗いテキスト（明るい背景用）
      emojiNode: THEME.colors.success,       // 絵文字置換済みノード
      warning: THEME.colors.warning         // 絵文字候補あり警告色
    };

    // N-gramサイズの降順でデータを取得
    const sizes = Object.keys(ngramResults)
      .map(Number)
      .sort((a, b) => b - a); // 降順ソート
    
    if (sizes.length === 0) return;

    // 文字列の長さに基づいて幅を計算する関数
    const calculateTextWidth = (text: string) => {
      // 絵文字の数をカウント
      const emojiCount = (text.match(/\p{Emoji}/gu) || []).length;
      // 絵文字以外の文字数
      const nonEmojiCount = text.length - emojiCount;
      
      // 絵文字には広めの幅を割り当て、通常文字には標準幅を割り当てる
      const emojiWidth = emojiCount * 25; // 絵文字1文字あたり25px
      const textWidth = nonEmojiCount * 15; // 通常文字1文字あたり15px
      
      // 合計幅 + パディング（最小幅を保証）
      return Math.max(emojiWidth + textWidth + 20, 50);
    };

    // 最上位テキストに絵文字置換を適用
    let displayRootText = hiraganaText;
    // 置換マップのキーを長さの降順でソート（長いものから先に処理）
    const rootKeys = Object.keys(ngramHomonymReplacement).sort((a, b) => b.length - a.length);
    
    // 該当する置換があれば適用
    for (const key of rootKeys) {
      if (hiraganaText.includes(key)) {
        const homonym = ngramHomonymReplacement[key];
        displayRootText = displayRootText.replace(new RegExp(key, 'g'), homonym);
      }
    }

    // ルートノードを描画
    const rootX = width / 2;
    const rootY = 50;
    
    // テキスト幅に基づいてルートノードのサイズを計算
    // ルートノードは長めのテキストになることが多いため、より広いパディングを追加
    const rootTextWidth = Math.max(calculateTextWidth(displayRootText), displayRootText.length * 15 + 30);
    const rootRectHeight = 36;
    
    // ルートノード（ひらがな変換結果を表示）- 角丸四角形で描画
    svg.append('rect')
      .attr('x', rootX - rootTextWidth / 2)
      .attr('y', rootY - rootRectHeight / 2)
      .attr('width', rootTextWidth)
      .attr('height', rootRectHeight)
      .attr('rx', 10) // 角の丸み
      .attr('ry', 10)
      .style('fill', COLORS.rootNode)
      .style('stroke', '#fff')
      .style('stroke-width', '2px');
    
    svg.append('text')
      .attr('x', rootX)
      .attr('y', rootY) // 中央揃え
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .style('font-size', '14px')
      .style('font-weight', 'bold')
      .style('fill', '#fff') // テキストを白色に
      .style('user-select', 'none') // テキスト選択を無効化
      .style('pointer-events', 'none') // テキスト要素へのポインターイベントを無効化
      .text(displayRootText);

    // レイヤー間隔の調整
    const layerSpacing = 90; // 層間の垂直間隔
    const layerStartY = rootY + 70; // 最初の層の開始Y座標
    
    // 各N-gramノードとその位置を保存するオブジェクト
    interface NgramNodeInfo {
      ngram: string;
      x: number;
      y: number;
      size: number;
      width: number; // 追加: 四角形の幅
      height: number; // 追加: 四角形の高さ
    }
    
    // サイズごとのN-gramノード情報を保持
    const ngramNodesBySize: { [size: number]: NgramNodeInfo[] } = {};
    
    // 各層のY座標
    const layerYPositions: { [size: number]: number } = {};
    
    // 各層（N-gramサイズ）ごとに処理
    sizes.forEach((size, layerIndex) => {
      const layerY = layerStartY + layerIndex * layerSpacing;
      layerYPositions[size] = layerY;
      
      // この層のN-gramを取得
      const ngrams = ngramResults[size] || [];
      ngramNodesBySize[size] = [];
      
      // N-gramノードを描画するための水平方向の間隔を計算
      const ngramWidth = width; // 左右の余白を調整（左端のラベルを削除したので幅を拡大）
      const ngramStartX = 0; // 左マージンを調整（左端のラベルがなくなったのでスペースを詰める）
      const ngramSpacing = ngrams.length <= 1 ? 0 : ngramWidth / Math.max(ngrams.length, 1);
      
      // 各N-gramノードを描画
      ngrams.forEach((ngram, index) => {
        const ngramX = ngrams.length <= 1 ? width / 2 : ngramStartX + index * ngramSpacing;
        const ngramY = layerY;
        
        // N-gramテキストに絵文字置換を適用
        let displayText = ngram;
        
        // 直接の置換があればそれを使用
        if (ngramHomonymReplacement[ngram]) {
          displayText = ngramHomonymReplacement[ngram];
        } 
        // それ以外の場合、部分的な置換を適用
        else {
          // 置換マップのキーを長さの降順でソート（長いものから先に処理）
          const keys = Object.keys(ngramHomonymReplacement).sort((a, b) => b.length - a.length);
          
          // 該当する置換があれば適用
          for (const key of keys) {
            if (ngram.includes(key)) {
              const homonym = ngramHomonymReplacement[key];
              displayText = displayText.replace(key, homonym);
            }
          }
        }
        
        // N-gramの四角形のサイズを計算
        const rectWidth = calculateTextWidth(displayText);
        const rectHeight = 28; // 高さをさらに小さくする
        
        // 選択状態の取得
        const isSelected = selectedWords[ngram] || false;
        const isHomonymReplaced = displayText !== ngram; // 表示テキストが変更されていれば絵文字置換済み
        
        // N-gramノード情報を保存
        ngramNodesBySize[size].push({
          ngram: ngram,
          x: ngramX,
          y: ngramY,
          size: 50, // 統一サイズに
          width: rectWidth,
          height: rectHeight
        });
        
        // N-gramノードの角丸四角形を描画
        let fillColor = COLORS.ngramNode; // デフォルトカラー
        if (isHomonymReplaced) {
          fillColor = COLORS.emojiNode; // 絵文字置換済みノードの色
        } else if (isSelected) {
          fillColor = COLORS.selectedNode; // 選択中ノードの色
        } else if (homonymCandidateCache[ngram]) {
          // 絵文字候補があるノードは警告色のボーダーを表示
          fillColor = COLORS.ngramNode;
        }
        
        svg.append('rect')
          .attr('x', ngramX - rectWidth / 2)
          .attr('y', ngramY - rectHeight / 2)
          .attr('width', rectWidth)
          .attr('height', rectHeight)
          .attr('rx', 6) // 角の丸みを小さく
          .attr('ry', 6)
          .style('fill', fillColor)
          .style('stroke', homonymCandidateCache[ngram] && !isHomonymReplaced ? COLORS.warning : '#fff')
          .style('stroke-width', homonymCandidateCache[ngram] && !isHomonymReplaced ? '2px' : '1px')
          .style('cursor', 'pointer')
          .on('click', function(event) {
            // クリックイベントの伝播を停止
            event.stopPropagation();
            
            // クリック位置を取得
            const mouseEvent = event as MouseEvent;
            const x = mouseEvent.clientX;
            const y = mouseEvent.clientY;
            
            // N-gramの選択状態を切り替え
            toggleNgramSelection(ngram);
            
            // 絵文字候補があれば表示
            if (homonymCandidateCache[ngram]) {
              // まず現在表示中のポップアップを閉じる
              setShowHomonymPopup(false);
              
              // 少し遅延させてから絵文字候補を検索して表示（UIの反応を良くするため）
              setTimeout(() => {
                // 絵文字候補を検索
                const candidates = findHomonymCandidates(ngram);
                
                // 絵文字候補があれば、ポップアップを表示
                if (candidates.length > 0) {
                  setHomonymCandidates(candidates);
                  setSelectedNgram(ngram);
                  setHomonymPopupPosition({x, y});
                  setShowHomonymPopup(true);
                }
              }, 10);
            }
          });
        
        // 絵文字候補があるノードに小さなインジケーターを追加
        if (homonymCandidateCache[ngram] && !isHomonymReplaced) {
          svg.append('circle')
            .attr('cx', ngramX + rectWidth / 2 - 6)
            .attr('cy', ngramY - rectHeight / 2 + 6)
            .attr('r', 4)
            .style('fill', COLORS.warning)
            .style('stroke', '#fff')
            .style('stroke-width', '1px');
        }
        
        // N-gramノードのテキストを描画
        svg.append('text')
          .attr('x', ngramX)
          .attr('y', ngramY)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .style('font-size', isHomonymReplaced ? '16px' : '13px') // フォントサイズ調整
          .style('fill', (isSelected || isHomonymReplaced) ? COLORS.textLight : COLORS.textDark)
          .style('user-select', 'none') // テキスト選択を無効化
          .style('pointer-events', 'none') // テキスト要素へのポインターイベントを無効化
          .text(displayText);
      });
    });
    
    // N-gram間の接続線を描画（さらにシンプル化）
    sizes.forEach((currentSize, layerIndex) => {
      // 最小サイズのN-gramは処理不要（これより小さいサイズはないため）
      if (layerIndex === sizes.length - 1) return;
      
      const nextSize = sizes[layerIndex + 1];
      const currentNgrams = ngramNodesBySize[currentSize] || [];
      const nextNgrams = ngramNodesBySize[nextSize] || [];
      
      // 現在の層の各N-gramについて
      currentNgrams.forEach(currentNgramInfo => {
        // 現在のN-gramの元のテキスト
        const currentOriginal = currentNgramInfo.ngram;
        
        // 次の層の各N-gramについて
        nextNgrams.forEach(nextNgramInfo => {
          // 次のN-gramの元のテキスト
          const nextOriginal = nextNgramInfo.ngram;
          
          // 部分文字列の関係をチェック（元のテキストで比較）
          if (currentOriginal.includes(nextOriginal)) {
            // 位置をチェック（先頭、末尾、または内部に含まれるかどうか）
            const position = currentOriginal.indexOf(nextOriginal);
            
            // 先頭、末尾、または連続した部分だけを接続
            if (position === 0 || 
                position + nextOriginal.length === currentOriginal.length ||
                position > 0) {
              
              // カーブのためのパス作成（シンプルに）
              const startX = currentNgramInfo.x;
              const startY = currentNgramInfo.y + currentNgramInfo.height / 2; // 始点ノードの下端
              const endX = nextNgramInfo.x;
              const endY = nextNgramInfo.y - nextNgramInfo.height / 2; // 終点ノードの上端
              
              // D3のパスジェネレーターを使用して直線的なカーブを描画
              const path = d3.path();
              path.moveTo(startX, startY);
              path.bezierCurveTo(
                startX, startY + (endY - startY) * 0.3, // 始点側の制御点
                endX, endY - (endY - startY) * 0.3,   // 終点側の制御点
                endX, endY    // 終点
              );
              
              // D3のパスジェネレーターを使って接続線を描画（薄く細く）
              svg.append('path')
                .attr('d', path.toString())
                .style('fill', 'none')
                .style('stroke', COLORS.connection)
                .style('stroke-width', '0.8px')
                .style('opacity', 0.5);
            }
          }
        });
      });
    });

    // ルートノードから最上位層へ接続（シンプル化）
    if (sizes.length > 0) {
      const topSize = sizes[0]; // 最大のN-gramサイズ
      const topLayerNgrams = ngramNodesBySize[topSize] || [];
      
      // 各N-gramノードへの接続線を描画
      topLayerNgrams.forEach(ngramInfo => {
        // カーブのためのパス作成
        const startX = rootX;
        const startY = rootY + rootRectHeight / 2; // ルートノードの下端
        const endX = ngramInfo.x;
        const endY = ngramInfo.y - ngramInfo.height / 2; // N-gramノードの上端
        
        // D3のパスジェネレーターを使用してベジェ曲線を描画
        const path = d3.path();
        path.moveTo(startX, startY);
        path.bezierCurveTo(
          startX, startY + (endY - startY) * 0.3, // 始点側の制御点
          endX, endY - (endY - startY) * 0.3,   // 終点側の制御点
          endX, endY    // 終点
        );
        
        // ルートノードからN-gramノードへの接続（薄く細く）
        svg.append('path')
          .attr('d', path.toString())
          .style('fill', 'none')
          .style('stroke', COLORS.connection)
          .style('stroke-width', '1px')
          .style('opacity', 0.5);
      });
    }

  }, [ngramResults, selectedWords, inputText, hiraganaText, treeData, ngramHomonymReplacement]);

  // useEffectフック
  useEffect(() => {
    const hiraText = convertToHiragana(inputText);
    setHiraganaText(hiraText);
    
    // Ensure n and m are within constraints
    const validN = Math.max(1, Math.min(ngramValue, 5));
    const validM = Math.max(validN, Math.min(mgramValue, 5));
    
    // Update the state with valid values if needed
    if (ngramValue !== validN) {
      setNgramValue(validN);
    }
    if (mgramValue !== validM) {
      setMgramValue(validM);
    }
    
    const ngrams = generateNgrams(hiraText, validN, validM);
    setNgramResults(ngrams);
  }, [inputText, ngramValue, mgramValue, convertToHiragana]);

  useEffect(() => {
    if (Object.keys(ngramResults).length > 0) {
      const tree = generateTreeData();
      setTreeData(tree);
    }
  }, [ngramResults, selectedWords, generateTreeData]);

  // 絵文字置換が変更されたら再描画
  useEffect(() => {
    if (treeData) {
      drawTree();
    }
  }, [treeData, drawTree, ngramHomonymReplacement]);

  // ドキュメント全体のクリックでポップアップを閉じるイベントリスナー
  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      // ポップアップ外のクリックだった場合は閉じる
      if (showHomonymPopup) {
        const popupElement = document.querySelector('.emoji-popup-container');
        if (popupElement && !popupElement.contains(e.target as Node)) {
          closeHomonymPopup();
        }
      }
    };
    
    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [showHomonymPopup]);

  // 絵文字候補のキャッシュを更新する関数
  const updateHomonymCandidateCache = useCallback(() => {
    const newCache: {[key: string]: boolean} = {};
    
    // 各N-gramについて絵文字候補があるかチェック
    Object.values(ngramResults).forEach(ngrams => {
      ngrams.forEach((ngram: string) => {
        // まだチェックしていないN-gramのみ処理
        if (newCache[ngram] === undefined) {
          newCache[ngram] = findHomonymCandidates(ngram).length > 0;
        }
      });
    });
    
    setHomonymCandidateCache(newCache);
  }, [ngramResults]);

  // N-gramの結果が変わったときに絵文字候補キャッシュを更新
  useEffect(() => {
    updateHomonymCandidateCache();
  }, [ngramResults, updateHomonymCandidateCache]);

  return (
    <div className="p-4 max-w-6xl mx-auto bg-white rounded-lg shadow-md">
      <style jsx global>{`
        .emoji-button {
          min-width: 2.5rem;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0.5rem 0.75rem;
        }
        .section-card {
          background-color: ${THEME.colors.light};
          border-radius: ${THEME.borderRadius.lg};
          padding: ${THEME.spacing[4]};
          margin-bottom: ${THEME.spacing[4]};
          box-shadow: ${THEME.shadows.sm};
          border: 1px solid ${THEME.colors.gray[200]};
        }
        .main-section-card {
          padding: ${THEME.spacing[4]};
          min-height: 650px;
        }
        .section-header {
          color: ${THEME.colors.dark};
          font-size: ${THEME.fontSizes.lg};
          font-weight: 600;
          margin-bottom: ${THEME.spacing[3]};
          border-bottom: 2px solid ${THEME.colors.primary};
          padding-bottom: ${THEME.spacing[2]};
        }
        .subsection-header {
          color: ${THEME.colors.dark};
          font-size: ${THEME.fontSizes.base};
          font-weight: 500;
          margin-bottom: ${THEME.spacing[2]};
        }
        .input-field {
          width: 100%;
          padding: ${THEME.spacing[2]} ${THEME.spacing[3]};
          border-radius: ${THEME.borderRadius.md};
          border: 1px solid ${THEME.colors.gray[300]};
          transition: all 0.3s ease;
          color: ${THEME.colors.dark};
        }
        .input-field::placeholder {
          color: ${THEME.colors.primary};
          opacity: 0.6;
        }
        .input-field:focus {
          border-color: ${THEME.colors.primary};
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3);
          outline: none;
        }
        .input-label {
          display: block;
          font-size: ${THEME.fontSizes.sm};
          font-weight: 500;
          color: ${THEME.colors.gray[600]};
          margin-bottom: ${THEME.spacing[1]};
        }
        .text-field-container {
          border: 1px solid ${THEME.colors.gray[300]};
          border-radius: ${THEME.borderRadius.md};
          background-color: ${THEME.colors.white};
          padding: ${THEME.spacing[2]} ${THEME.spacing[3]};
          min-height: 38px;
          width: 100%;
          color: ${THEME.colors.dark};
        }
        .ngram-button {
          padding: ${THEME.spacing[1]} ${THEME.spacing[2]};
          border-radius: ${THEME.borderRadius.full};
          font-size: ${THEME.fontSizes.sm};
          font-weight: 500;
          transition: all 0.2s ease;
        }
        .ngram-button-default {
          background-color: ${THEME.colors.gray[200]};
          color: ${THEME.colors.gray[700]};
        }
        .ngram-button-default:hover {
          background-color: ${THEME.colors.gray[300]};
        }
        .ngram-button-selected {
          background-color: ${THEME.colors.secondary};
          color: ${THEME.colors.white};
        }
        .ngram-button-emoji {
          background-color: ${THEME.colors.success};
          color: ${THEME.colors.white};
        }
        .ngram-button-candidate {
          background-color: ${THEME.colors.light};
          color: ${THEME.colors.gray[700]};
          border: 2px solid ${THEME.colors.warning};
        }
        .ngram-button-candidate:hover {
          background-color: ${THEME.colors.gray[200]};
        }
        .emoji-badge {
          position: absolute;
          top: -4px;
          right: -4px;
          width: 16px;
          height: 16px;
          background-color: ${THEME.colors.warning};
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 8px;
          color: ${THEME.colors.white};
        }
        .emoji-popup {
          background-color: ${THEME.colors.white};
          border-radius: ${THEME.borderRadius.md};
          padding: ${THEME.spacing[3]};
          box-shadow: ${THEME.shadows.lg};
          border: 1px solid ${THEME.colors.gray[300]};
          z-index: 50;
        }
        .emoji-candidate-button {
          padding: ${THEME.spacing[2]};
          font-size: ${THEME.fontSizes.xl};
          border-radius: ${THEME.borderRadius.md};
          transition: background-color 0.2s ease;
        }
        .emoji-candidate-button:hover {
          background-color: ${THEME.colors.gray[100]};
        }
        .emoji-popup-title {
          font-size: ${THEME.fontSizes.sm};
          font-weight: 500;
          margin-bottom: ${THEME.spacing[2]};
          color: ${THEME.colors.gray[600]};
        }
        .text-display {
          padding: ${THEME.spacing[2]};
          background-color: ${THEME.colors.white};
          border-radius: ${THEME.borderRadius.md};
          border: 1px solid ${THEME.colors.gray[200]};
        }
        .two-column-layout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
        }
        .three-column-layout {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 1rem;
        }
        @media (max-width: 1024px) {
          .two-column-layout, .three-column-layout {
            grid-template-columns: 1fr;
          }
        }
        .switch-tabs {
          display: flex;
          border-bottom: 1px solid ${THEME.colors.gray[200]};
          margin-bottom: ${THEME.spacing[4]};
        }
        .tab-button {
          padding: ${THEME.spacing[2]} ${THEME.spacing[4]};
          border-bottom: 3px solid transparent;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .tab-button.active {
          border-bottom-color: ${THEME.colors.primary};
          color: ${THEME.colors.primary};
        }
        .tab-button:hover:not(.active) {
          border-bottom-color: ${THEME.colors.gray[300]};
        }
        .svg-container svg {
          user-select: none;
        }
        .svg-container text {
          user-select: none;
          pointer-events: none;
        }
        
        /* SVGの選択を無効化するスタイル */
        svg {
          user-select: none !important;
          -webkit-user-select: none !important;
          -moz-user-select: none !important;
          -ms-user-select: none !important;
        }
        
        svg text {
          user-select: none !important;
          -webkit-user-select: none !important;
          -moz-user-select: none !important;
          -ms-user-select: none !important;
          pointer-events: none !important;
        }
      `}</style>
      
      <h1 className="text-2xl font-bold text-center mb-4 text-gray-800 pb-2 border-b-2 border-primary">
        日本語テキスト解析 & 同音異義語抽出
      </h1>

      <div className="space-y-4">
        {/* 上段: テキスト入力とひらがな変換結果の横並び */}
        <div className="two-column-layout">
          {/* 左側: テキスト入力セクション */}
          <div className="section-card">
            <h2 className="section-header">テキスト入力</h2>
            <div className="mb-3">
              <label htmlFor="inputText" className="input-label">
            テキストを入力
          </label>
          <input
            id="inputText"
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
                className="input-field"
                placeholder="ここに文字列を入力してください"
          />
        </div>

        <div className="flex space-x-4">
              <div className="flex-1">
                <label htmlFor="ngramValue" className="input-label">
                  N-gramの長さ（最小 1-5）
                </label>
                <input
                  id="ngramValue"
                  type="number"
                  min="1"
                  max="5"
                  value={ngramValue}
                  onChange={(e) => setNgramValue(Number(e.target.value))}
                  className="input-field"
                />
              </div>
              <div className="flex-1">
                <label htmlFor="mgramValue" className="input-label">
                  N-gramの長さ（最大 1-5）
            </label>
            <input
              id="mgramValue"
              type="number"
              min="1"
                  max="5"
              value={mgramValue}
              onChange={(e) => setMgramValue(Number(e.target.value))}
                  className="input-field"
            />
              </div>
            </div>
          </div>

          {/* 右側: ひらがな変換結果セクション */}
          <div className="section-card">
            <h2 className="section-header">ひらがな変換結果</h2>
            
            {/* 元のひらがなテキスト（変換前） */}
            <div className="mb-3">
              <h3 className="subsection-header">元のテキスト：</h3>
              <div className="text-field-container">
                {hiraganaText || "テキストが入力されると表示されます"}
              </div>
            </div>
            
            {/* 同音異義語置換後のテキスト */}
          <div>
              <h3 className="subsection-header">同音異義語置換後：</h3>
              <div className="text-field-container">
                {(() => {
                  let displayText = hiraganaText;
                  // 同音異義語置換を適用
                  const keys = Object.keys(ngramHomonymReplacement).sort((a, b) => b.length - a.length);
                  for (const key of keys) {
                    if (hiraganaText.includes(key)) {
                      const homonym = ngramHomonymReplacement[key];
                      displayText = displayText.replace(new RegExp(key, 'g'), homonym);
                    }
                  }
                  return displayText || "テキストが入力されると表示されます";
                })()}
              </div>
            </div>
          </div>
        </div>

        {/* N-gramツリー可視化 */}
        <div className="section-card main-section-card">
          <h2 className="section-header">N-gram ツリー可視化</h2>
          <div className="border rounded-lg bg-white relative svg-container" style={{ height: '400px', userSelect: 'none' }}>
            <svg ref={svgRef} width="1200" height="500"></svg>
            
            {/* 同音異義語候補のポップアップ */}
            {showHomonymPopup && (
              <div 
                className="fixed emoji-popup"
                style={{ 
                  left: `${homonymPopupPosition.x}px`, 
                  top: `${homonymPopupPosition.y + window.scrollY}px`,
                  transform: 'translate(-50%, 10px)'
                }}
                onClick={(e) => e.stopPropagation()} // ポップアップ内のクリックがドキュメントに伝播しないようにする
              >
                <div className="emoji-popup-title">「{selectedNgram}」の同音異義語候補:</div>
                <div className="flex flex-wrap gap-2 max-w-xs">
                  {homonymCandidates.map((candidate, index) => (
                        <button
                      key={index}
                      onClick={(e) => {
                        e.stopPropagation(); // クリック伝播を停止
                        applyHomonym(candidate.homonym);
                      }}
                      className="emoji-candidate-button"
                      title={candidate.meaning || ''}
                    >
                      {candidate.homonym}
                        </button>
                      ))}
                    </div>
                <button 
                  className="absolute top-2 right-2 text-gray-500 hover:text-gray-700"
                  onClick={(e) => {
                    e.stopPropagation(); // クリック伝播を停止
                    closeHomonymPopup();
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
          <div className="mt-4 text-sm text-gray-600">
            <p className="mb-1">
              <span className="font-semibold">使い方:</span> N-gramノードをクリックすると選択状態を切り替えます。同音異義語候補がある場合はポップアップが表示されます。
            </p>
            <div className="flex gap-4 mt-2">
              <div className="flex items-center">
                <div className="w-4 h-4 rounded-sm bg-gray-200 mr-2"></div>
                <span>通常のN-gram</span>
              </div>
              <div className="flex items-center">
                <div className="w-4 h-4 rounded-sm bg-indigo-500 mr-2"></div>
                <span>選択中のN-gram</span>
              </div>
              <div className="flex items-center">
                <div className="w-4 h-4 rounded-sm bg-green-500 mr-2"></div>
                <span>同音異義語置換済み</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default JapaneseTextAnalyzer; 
